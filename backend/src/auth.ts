import { Context, MiddlewareHandler } from "hono";
import { Env, KosyncErrors } from "./types";
import { getUserByUsername } from "./db";

/**
 * Convert buffer to hex string.
 */
function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert hex string to Uint8Array.
 */
function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Hash a password or PIN using PBKDF2-HMAC-SHA256 (100,000 iterations).
 * Format: pbkdf2:100000:<salt_hex>:<hash_hex>
 */
export async function hashPasswordPBKDF2(password: string, saltHex?: string): Promise<string> {
  const encoder = new TextEncoder();
  let salt: Uint8Array;
  if (saltHex) {
    salt = hexToBuffer(saltHex);
  } else {
    salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256 // 32 bytes
  );

  const derivedHex = bufferToHex(derivedBits);
  const finalSaltHex = bufferToHex(salt);
  return `pbkdf2:100000:${finalSaltHex}:${derivedHex}`;
}

/**
 * Legacy single-round SHA-256 hash for backwards compatibility.
 */
export async function hashPasswordLegacy(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`koreader_salt_${password}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash a password using PBKDF2 by default.
 */
export async function hashPassword(password: string): Promise<string> {
  return hashPasswordPBKDF2(password);
}

/**
 * Hash a Pairing PIN with PBKDF2.
 */
export async function hashPin(pin: string): Promise<string> {
  return hashPasswordPBKDF2(pin);
}

/**
 * Verify a password against a stored hash (supports both PBKDF2 and legacy SHA-256).
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!password || !storedHash) {
    return { valid: false, needsRehash: false };
  }

  if (storedHash.startsWith("pbkdf2:100000:")) {
    const parts = storedHash.split(":");
    if (parts.length === 4) {
      const saltHex = parts[2];
      const expectedHash = await hashPasswordPBKDF2(password, saltHex);
      return { valid: timingSafeEqual(expectedHash, storedHash), needsRehash: false };
    }
  }

  // Fallback: Verify legacy SHA-256 hash
  const legacyHash = await hashPasswordLegacy(password);
  if (timingSafeEqual(legacyHash, storedHash)) {
    return { valid: true, needsRehash: true };
  }

  return { valid: false, needsRehash: false };
}

/**
 * Verify a Pairing PIN against a stored hash or environment secret.
 */
export async function verifyPin(pin: string, storedHashOrSecret: string): Promise<boolean> {
  if (!pin || !storedHashOrSecret) return false;
  if (storedHashOrSecret.startsWith("pbkdf2:")) {
    const { valid } = await verifyPassword(pin, storedHashOrSecret);
    return valid;
  }
  return timingSafeEqual(pin, storedHashOrSecret);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate that a field is non-empty string and does not contain illegal characters (e.g. colons).
 */
export function isValidKeyField(val: unknown): val is string {
  return typeof val === "string" && val.length > 0 && !val.includes(":");
}

export function isValidString(val: unknown): val is string {
  return typeof val === "string" && val.length > 0;
}

/**
 * Extract authentication credentials from request headers or body.
 */
export async function extractCredentials(
  c: Context<{ Bindings: Env; Variables: { username: string } }>
): Promise<{ username: string; userKey: string } | null> {
  const headerUser = c.req.header("x-auth-user");
  const headerKey = c.req.header("x-auth-key");

  if (isValidKeyField(headerUser) && isValidString(headerKey)) {
    return { username: headerUser, userKey: headerKey };
  }

  // Check Authorization header (e.g. Bearer or Basic)
  const authHeader = c.req.header("authorization");
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const colonIdx = decoded.indexOf(":");
      if (colonIdx > 0) {
        const username = decoded.slice(0, colonIdx);
        const userKey = decoded.slice(colonIdx + 1);
        if (isValidKeyField(username) && isValidString(userKey)) {
          return { username, userKey };
        }
      }
    } catch {
      // Ignore decoding failure
    }
  }

  // If method is POST and Content-Type is json, try body as fallback
  if (c.req.method === "POST" && c.req.header("content-type")?.includes("application/json")) {
    try {
      const body = await c.req.json().catch(() => null);
      if (body && isValidKeyField(body.username) && isValidString(body.password)) {
        return { username: body.username, userKey: body.password };
      }
    } catch {
      // Ignore body parsing failure
    }
  }

  return null;
}

/**
 * Authenticate credentials against D1 database.
 */
export async function authenticate(
  db: D1Database,
  username: string,
  userKey: string
): Promise<boolean> {
  const user = await getUserByUsername(db, username);
  if (!user) {
    return false;
  }

  const { valid, needsRehash } = await verifyPassword(userKey, user.password_hash);
  if (!valid) {
    return false;
  }

  if (needsRehash) {
    try {
      const newHash = await hashPassword(userKey);
      await db
        .prepare("UPDATE users SET password_hash = ? WHERE username = ?")
        .bind(newHash, username)
        .run();
    } catch (err) {
      console.warn("Failed to auto-upgrade legacy password hash:", err);
    }
  }

  return true;
}

/**
 * Hono Middleware requiring Kosync authentication.
 */
export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: { username: string };
}> = async (c, next) => {
  const creds = await extractCredentials(c);
  if (!creds) {
    return c.json(
      { code: KosyncErrors.UNAUTHORIZED.code, message: KosyncErrors.UNAUTHORIZED.message },
      KosyncErrors.UNAUTHORIZED.status
    );
  }

  const isValid = await authenticate(c.env.DB, creds.username, creds.userKey);
  if (!isValid) {
    return c.json(
      { code: KosyncErrors.UNAUTHORIZED.code, message: KosyncErrors.UNAUTHORIZED.message },
      KosyncErrors.UNAUTHORIZED.status
    );
  }

  c.set("username", creds.username);
  await next();
};
