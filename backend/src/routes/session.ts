import { Hono } from "hono";
import { Env, KosyncErrors } from "../types";
import {
  ensureDatabase,
  createUser,
  getUserByUsername,
  getAppConfig,
  setAppConfig,
  addTrustedBrowser,
  verifyTrustedBrowser,
  revokeTrustedBrowser,
  revokeAllTrustedBrowsers,
} from "../db";
import {
  hashPassword,
  hashPin,
  verifyPin,
  verifyPassword,
  timingSafeEqual,
  requireAuth,
  generateBrowserToken,
  hashToken,
} from "../auth";

export const sessionRouter = new Hono<{ Bindings: Env; Variables: { username: string } }>();

// In-memory fallback cache for sessions
interface MemorySession {
  status: string;
  pollToken: string;
  username: string;
  userkey: string;
  expiresAt: number;
  failedAttempts: number;
}

const memorySessions = new Map<string, MemorySession>();

// Helper: Generate random 6-character uppercase alphanumeric code (omitting ambiguous characters 0, 1, I, O)
function generateSessionId(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let result = "";
  const randomBytes = new Uint8Array(6);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < 6; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

// Helper: Generate 32-character hex secret poll token
function generatePollToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Ensure session table exists in D1
async function ensureSessionTable(db: D1Database): Promise<void> {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        session_id TEXT PRIMARY KEY,
        poll_token TEXT,
        status TEXT NOT NULL,
        username TEXT,
        userkey TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    try {
      await db.prepare("ALTER TABLE pairing_sessions ADD COLUMN poll_token TEXT").run();
    } catch {}
  } catch (err) {
    console.warn("Pairing session table init warning:", err);
  }
}

// 0. GET /api/session/status -> Checks whether the server already has a PIN configured and validates browser tokens
sessionRouter.get("/status", async (c) => {
  const db = c.env.DB;
  let isConfigured = false;
  let isBrowserTrusted = false;

  const reqBrowserToken =
    c.req.header("x-browser-token") || c.req.query("browser_token") || "";

  if (c.env.PAIRING_PIN || c.env.PAIRING_SECRET) {
    isConfigured = true;
  }
  if (db) {
    try {
      await ensureDatabase(db);
      const pinHash = await getAppConfig(db, "pairing_pin_hash");
      if (pinHash) isConfigured = true;

      if (reqBrowserToken) {
        const tokenHash = await hashToken(reqBrowserToken);
        isBrowserTrusted = await verifyTrustedBrowser(db, tokenHash);
      }
    } catch {
      isConfigured = false;
    }
  }

  return c.json({
    is_configured: isConfigured,
    has_pin: isConfigured,
    browser_trusted: isBrowserTrusted,
  });
});

// 1. POST /api/session/create -> E-reader requests pairing code and secret poll token
sessionRouter.post("/create", async (c) => {
  const db = c.env.DB;
  const sessionId = generateSessionId();
  const pollToken = generatePollToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 600; // 10 minutes TTL

  memorySessions.set(sessionId, {
    status: "pending",
    pollToken,
    username: "",
    userkey: "",
    expiresAt: expiresAt * 1000,
    failedAttempts: 0,
  });

  if (db) {
    try {
      await ensureSessionTable(db);
      await db
        .prepare(
          "INSERT INTO pairing_sessions (session_id, poll_token, status, expires_at, created_at) VALUES (?, ?, 'pending', ?, ?)"
        )
        .bind(sessionId, pollToken, expiresAt, now)
        .run();
    } catch (err) {
      console.warn("Failed to persist session to D1, using memory store:", err);
    }
  }

  return c.json({
    success: true,
    session_id: sessionId,
    poll_token: pollToken,
    expires_in: 600,
  });
});

// 2. GET /api/session/:id/poll -> E-reader polls for confirmation (requires poll_token)
sessionRouter.get("/:id/poll", async (c) => {
  const sessionId = c.req.param("id").toUpperCase();
  const reqPollToken = c.req.header("x-poll-token") || c.req.query("token") || "";
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  let session = memorySessions.get(sessionId);

  if ((!session || session.status !== "ready") && db) {
    try {
      await ensureSessionTable(db);
      const row = await db
        .prepare(
          "SELECT session_id, poll_token, status, username, userkey, expires_at FROM pairing_sessions WHERE session_id = ?"
        )
        .bind(sessionId)
        .first<{
          session_id: string;
          poll_token: string | null;
          status: string;
          username: string;
          userkey: string;
          expires_at: number;
        }>();

      if (row) {
        if (row.expires_at < now) {
          return c.json({ error: "Session expired" }, 404);
        }
        session = {
          status: row.status,
          pollToken: row.poll_token || (session ? session.pollToken : ""),
          username: row.username || "",
          userkey: row.userkey || "",
          expiresAt: row.expires_at * 1000,
          failedAttempts: session ? session.failedAttempts : 0,
        };
      }
    } catch (err) {
      console.warn("Error querying D1 session:", err);
    }
  }

  if (!session || session.expiresAt < Date.now()) {
    return c.json({ error: "Session expired or not found" }, 404);
  }

  // Validate poll_token if one was established for this session
  if (session.pollToken) {
    if (!reqPollToken || !timingSafeEqual(reqPollToken, session.pollToken)) {
      return c.json(
        {
          success: false,
          error: "Unauthorized: Invalid or missing poll token.",
        },
        401
      );
    }
  }

  if (session.status === "ready" && session.username && session.userkey) {
    const origin = new URL(c.req.url).origin;
    return c.json({
      success: true,
      status: "ready",
      username: session.username,
      userkey: session.userkey,
      server_url: origin,
    });
  }

  // Still waiting for phone/browser confirmation
  return c.body(null, 204);
});

// 3. POST /api/session/:id/submit -> Phone/PC browser confirms pairing with PIN
sessionRouter.post("/:id/submit", async (c) => {
  const sessionId = c.req.param("id").toUpperCase();
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  let session = memorySessions.get(sessionId);

  if ((!session || session.expiresAt < Date.now()) && db) {
    try {
      await ensureSessionTable(db);
      const row = await db
        .prepare(
          "SELECT session_id, poll_token, status, username, userkey, expires_at FROM pairing_sessions WHERE session_id = ?"
        )
        .bind(sessionId)
        .first<{
          session_id: string;
          poll_token: string | null;
          status: string;
          username: string;
          userkey: string;
          expires_at: number;
        }>();

      if (row && row.expires_at >= now) {
        session = {
          status: row.status,
          pollToken: row.poll_token || (session ? session.pollToken : ""),
          username: row.username || "",
          userkey: row.userkey || "",
          expiresAt: row.expires_at * 1000,
          failedAttempts: session ? session.failedAttempts : 0,
        };
      }
    } catch (err) {
      console.warn("Error querying D1 session:", err);
    }
  }

  if (!session || session.expiresAt < Date.now()) {
    return c.json(
      {
        success: false,
        error: "Pairing code not found or expired. Please check the code shown on your e-reader screen.",
      },
      404
    );
  }

  // Rate limiting check
  if (session.failedAttempts >= 5) {
    return c.json(
      {
        success: false,
        error: "Too many failed attempts. Please generate a new pairing code on your e-reader.",
      },
      429
    );
  }

  let body: {
    username?: string;
    userkey?: string;
    pin?: string;
    trust_browser?: boolean;
    browser_token?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const username = (body.username || "primary_reader").trim();
  const submittedPin = (body.pin || "").trim();
  const reqBrowserToken =
    (c.req.header("x-browser-token") || body.browser_token || "").trim();

  // Determine existing security state
  let configuredPinHash: string | null = null;
  let existingUser: any = null;
  const envPin = c.env.PAIRING_PIN || c.env.PAIRING_SECRET;

  if (db) {
    try {
      await ensureDatabase(db);
      configuredPinHash = await getAppConfig(db, "pairing_pin_hash");
      existingUser = await getUserByUsername(db, username);
    } catch (err) {
      console.error("Error reading database security configuration:", err);
    }
  }

  const isServerConfigured = !!(configuredPinHash || envPin);
  let userkey = "";

  if (!isServerConfigured) {
    // FIRST-TIME SETUP: Require user to establish an exact 4-digit PIN
    if (!submittedPin || !/^\d{4}$/.test(submittedPin)) {
      session.failedAttempts++;
      return c.json(
        {
          success: false,
          error: "Please choose a 4-digit numeric Pairing PIN (0000-9999) to protect your server.",
        },
        400
      );
    }

    if (db) {
      try {
        const hashedPin = await hashPin(submittedPin);
        await setAppConfig(db, "pairing_pin_hash", hashedPin);

        // Reuse existing sync_key if user already exists, otherwise create new user
        if (existingUser && existingUser.sync_key) {
          userkey = existingUser.sync_key;
        } else {
          const randomBytes = new Uint8Array(16);
          crypto.getRandomValues(randomBytes);
          userkey =
            "sink_key_" +
            Array.from(randomBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");

          const passHash = await hashPassword(userkey);
          await createUser(db, username, passHash, userkey);
        }
      } catch (err) {
        console.error("Error establishing initial PIN and user:", err);
      }
    } else {
      userkey = (existingUser && existingUser.sync_key) || `sink_key_${sessionId}`;
    }
  } else {
    // SUBSEQUENT PAIRING: Authenticate via trusted browser token, PIN, or existing credentials
    let isAuthorized = false;

    // 1. Authorize via trusted browser token
    if (reqBrowserToken && db) {
      const tokenHash = await hashToken(reqBrowserToken);
      if (await verifyTrustedBrowser(db, tokenHash)) {
        isAuthorized = true;
      }
    }

    // 2. Authorize via submitted PIN
    if (!isAuthorized && submittedPin) {
      if (envPin && (await verifyPin(submittedPin, envPin))) {
        isAuthorized = true;
        // Keep DB PIN hash in sync with envPin override
        if (db) {
          try {
            const hashedPin = await hashPin(submittedPin);
            await setAppConfig(db, "pairing_pin_hash", hashedPin);
          } catch {}
        }
      } else if (configuredPinHash && (await verifyPin(submittedPin, configuredPinHash))) {
        isAuthorized = true;
      }
    }

    // Fallback: Owner who enters their existing userkey directly
    if (!isAuthorized && body.userkey && existingUser) {
      const { valid } = await verifyPassword(body.userkey.trim(), existingUser.password_hash);
      if (valid) {
        isAuthorized = true;
        if (db && submittedPin && /^\d{4}$/.test(submittedPin)) {
          try {
            const hashedPin = await hashPin(submittedPin);
            await setAppConfig(db, "pairing_pin_hash", hashedPin);
          } catch (err) {
            console.error("Error establishing initial PIN via userkey fallback:", err);
          }
        }
      }
    }

    if (!isAuthorized) {
      session.failedAttempts++;
      memorySessions.set(sessionId, session);
      return c.json(
        {
          success: false,
          error: "Invalid Pairing PIN. Check your PIN or reset it from your paired e-reader.",
        },
        401
      );
    }

    // Use existing account's sync key (NEVER overwrite password_hash)
    if (existingUser && existingUser.sync_key) {
      userkey = existingUser.sync_key;
    } else {
      userkey = body.userkey || `sink_key_${sessionId}`;
      if (db && !existingUser) {
        try {
          const passHash = await hashPassword(userkey);
          await createUser(db, username, passHash, userkey);
        } catch (err) {
          console.error("Error creating user during subsequent pairing:", err);
        }
      }
    }
  }

  if (!userkey) {
    userkey = `sink_key_${sessionId}`;
  }

  // Issue trusted browser token if requested (valid for 1 year with rolling renewal)
  let newBrowserToken: string | null = null;
  if (body.trust_browser && db) {
    try {
      newBrowserToken = generateBrowserToken();
      const tokenHash = await hashToken(newBrowserToken);
      await addTrustedBrowser(db, tokenHash, 365 * 86400);
    } catch (err) {
      console.warn("Failed to issue trusted browser token:", err);
    }
  }

  // Update session status to ready
  session.status = "ready";
  session.username = username;
  session.userkey = userkey;
  session.expiresAt = Date.now() + 600000;
  memorySessions.set(sessionId, session);

  if (db) {
    try {
      await ensureSessionTable(db);
      await db
        .prepare(
          "UPDATE pairing_sessions SET status = 'ready', username = ?, userkey = ? WHERE session_id = ?"
        )
        .bind(username, userkey, sessionId)
        .run();
    } catch (err) {
      console.warn("Failed to update D1 session:", err);
    }
  }

  return c.json({
    success: true,
    message: "Device paired successfully! Your e-reader will automatically connect.",
    browser_token: newBrowserToken || undefined,
  });
});

// 4. POST /api/session/reset-pin -> Authenticated reset from already-paired Kindle
sessionRouter.post("/reset-pin", requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) {
    return c.json({ success: false, error: "Database not configured." }, 500);
  }

  let body: { new_pin?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const newPin = (body.new_pin || "").trim();
  if (!newPin || !/^\d{4}$/.test(newPin)) {
    return c.json(
      {
        success: false,
        error: "New PIN must be an exact 4-digit number (0000-9999).",
      },
      400
    );
  }

  try {
    await ensureDatabase(db);
    const pinHash = await hashPin(newPin);
    await setAppConfig(db, "pairing_pin_hash", pinHash);
    // Invalidate all existing browser tokens when the PIN is reset
    await revokeAllTrustedBrowsers(db);
    return c.json({
      success: true,
      message: "Pairing PIN updated successfully. All trusted browser sessions have been reset.",
    });
  } catch (err: any) {
    return c.json(
      {
        success: false,
        error: "Database error: " + (err.message || String(err)),
      },
      500
    );
  }
});

// 5. POST /api/session/revoke-browser -> Invalidate trusted browser session
sessionRouter.post("/revoke-browser", async (c) => {
  const db = c.env.DB;
  if (!db) {
    return c.json({ success: false, error: "Database not configured." }, 500);
  }

  let body: { browser_token?: string } = {};
  try {
    body = await c.req.json();
  } catch {}

  const token = (c.req.header("x-browser-token") || body.browser_token || "").trim();
  if (token) {
    const tokenHash = await hashToken(token);
    await revokeTrustedBrowser(db, tokenHash);
  }

  return c.json({ success: true, message: "Browser authorization revoked." });
});
