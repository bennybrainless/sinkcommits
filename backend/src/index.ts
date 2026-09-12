import { Hono } from "hono";
import { cors } from "hono/cors";
import { Env, KosyncErrors } from "./types";
import { healthRouter } from "./routes/health";
import { usersRouter } from "./routes/users";
import { syncsRouter } from "./routes/syncs";
import { sessionRouter } from "./routes/session";
import { ensureDatabase } from "./db";

const app = new Hono<{ Bindings: Env; Variables: { username: string } }>();

// Enable CORS for web clients / dashboard on users and syncs routes (pairing session endpoints are same-origin)
app.use(
  "/users/*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Auth-User",
      "X-Auth-Key",
      "Accept",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Auth-User", "X-Auth-Token"],
  })
);
app.use(
  "/syncs/*",
  cors({
    origin: "*",
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Auth-User",
      "X-Auth-Key",
      "Accept",
    ],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Auth-User", "X-Auth-Token"],
  })
);

// Mount route modules
app.route("/", healthRouter);
app.route("/users", usersRouter);
app.route("/syncs", syncsRouter);
app.route("/api/session", sessionRouter);

// Attach backend version header to all responses
app.use("*", async (c, next) => {
  await next();
  c.header("X-Sink-Backend-Version", "1.1.0");
});

// Root Route: Interactive Mobile Web Pairing Portal / JSON Info (for APIs)
app.get("/", async (c) => {
  const acceptHeader = c.req.header("accept") || "";

  // If request is from API or KOReader, return JSON
  if (
    !acceptHeader.includes("text/html") &&
    (acceptHeader.includes("application/json") ||
      acceptHeader.includes("application/vnd.koreader.v1+json"))
  ) {
    return c.json({
      service: "Sink KOReader Sync Server",
      status: "running",
      version: "1.1.0",
      docs: "https://github.com/ultimatejimmy/sink",
    });
  }

  // Ensure database tables exist
  let dbStatus = "Connected & Ready";
  try {
    if (c.env.DB) {
      await ensureDatabase(c.env.DB);
    }
  } catch (e) {
    dbStatus = "Database Error: " + String(e);
  }

  const origin = new URL(c.req.url).origin;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sink — KOReader Device Pairing</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131d2e;
      --border: #223249;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #7dd3fc;
      --success: #34d399;
      --error: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 1.5rem 1rem; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 1.25rem; padding: 1.75rem; max-width: 480px; width: 100%; box-shadow: 0 20px 40px -10px rgba(0,0,0,0.6); }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
    .header h1 { font-size: 1.4rem; font-weight: 800; color: var(--primary); letter-spacing: -0.5px; }
    .badge { font-size: 0.75rem; font-weight: 700; color: var(--success); background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.3); padding: 4px 10px; border-radius: 9999px; }
    .notice { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 12px; padding: 12px 14px; margin-bottom: 1.25rem; font-size: 0.82rem; color: #cbd5e1; line-height: 1.45; }
    .notice strong { color: var(--primary); }
    .step-title { font-size: 1.15rem; font-weight: 800; margin-bottom: 0.5rem; text-align: center; }
    .step-desc { font-size: 0.85rem; color: var(--text-muted); text-align: center; margin-bottom: 1.25rem; line-height: 1.45; }
    .code-input-wrap { max-width: 260px; margin: 0 auto 1.25rem auto; }
    .code-input { width: 100%; background: #0b121e; border: 2px solid var(--primary); color: var(--primary); border-radius: 12px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.75rem; font-weight: 800; letter-spacing: 6px; text-transform: uppercase; text-align: center; outline: none; box-shadow: 0 0 15px rgba(56, 189, 248, 0.15); }
    .code-input:focus { border-color: var(--primary-hover); box-shadow: 0 0 20px rgba(56, 189, 248, 0.3); }
    .pin-input-container { position: relative; width: 100%; }
    .pin-input { width: 100%; background: #0b121e; border: 1px solid var(--border); color: var(--text); border-radius: 10px; padding: 12px 42px 12px 12px; font-size: 1.3rem; font-weight: 700; text-align: center; letter-spacing: 8px; outline: none; margin-bottom: 0.35rem; transition: border-color 0.15s; font-family: ui-monospace, SFMono-Regular, monospace; }
    .pin-input:focus { border-color: var(--primary); }
    .btn-eye { position: absolute; right: 10px; top: 12px; background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; font-size: 1.1rem; user-select: none; }
    .btn-eye:hover { color: var(--text); }
    .trusted-card { background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 12px; padding: 12px 14px; margin-bottom: 1.25rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; }
    .trusted-card strong { color: var(--success); }
    .trust-row { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: var(--text-muted); margin-bottom: 1.25rem; user-select: none; }
    .trust-row input[type="checkbox"] { accent-color: var(--primary); width: 16px; height: 16px; cursor: pointer; }
    .btn-primary { width: 100%; background: var(--primary); color: #090d16; border: none; border-radius: 12px; padding: 14px; font-size: 1rem; font-weight: 800; cursor: pointer; transition: all 0.15s ease; display: flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-primary:disabled { background: #1e293b; color: #64748b; cursor: not-allowed; }
    .alert { padding: 12px 14px; border-radius: 10px; font-size: 0.85rem; margin-top: 1rem; display: none; line-height: 1.45; font-weight: 600; text-align: center; }
    .alert.success { background: rgba(52, 211, 153, 0.15); border: 1px solid var(--success); color: var(--success); }
    .alert.error { background: rgba(248, 113, 113, 0.15); border: 1px solid var(--error); color: var(--error); }
    .footer-help { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: 0.78rem; color: var(--text-muted); line-height: 1.5; }
    .pin-wrap { margin-bottom: 0.75rem; text-align: left; }
    .pin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .pin-label { font-size: 0.82rem; font-weight: 700; color: var(--text-muted); }
    .btn-link { background: none; border: none; font-size: 0.76rem; color: var(--primary); cursor: pointer; padding: 0; text-decoration: none; }
    .btn-link:hover { text-decoration: underline; }
    .help-panel { background: rgba(15, 23, 42, 0.95); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 1.25rem; font-size: 0.82rem; line-height: 1.5; display: none; text-align: left; }
    .help-panel h3 { font-size: 0.85rem; color: var(--primary); margin-bottom: 6px; }
    .help-panel ol { margin-left: 1.2rem; color: #cbd5e1; }
    .help-panel li { margin-bottom: 6px; }
    .help-panel code { background: rgba(56, 189, 248, 0.15); color: var(--primary); padding: 1px 5px; border-radius: 4px; font-size: 0.78rem; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Sink</h1>
      <span class="badge" id="serverBadge">● Online</span>
    </div>

    <div class="notice">
      🔒 <strong>Device Pairing</strong>: Link your e-reader to sync reading progress silently and automatically.
    </div>

    <div class="step-title" id="stepTitle">Connect E-Reader</div>
    <p class="step-desc" id="stepDesc">
      On your Kindle/KOReader, tap <strong>Tools &rarr; Sink &rarr; Pair Device (Phone/PC)</strong> to generate a 6-character code.
    </p>

    <!-- Expandable Help Box for PIN Reset / Recovery -->
    <div id="forgotPinHelp" class="help-panel">
      <h3>🔑 Pairing PIN Help &amp; Recovery</h3>
      <ol>
        <li><strong>Set PIN in Cloudflare Dashboard (Recommended):</strong><br>
          In Cloudflare Dashboard &rarr; Workers &rarr; your worker &rarr; <em>Settings &rarr; Variables and Secrets</em>, add <code>PAIRING_PIN</code> with your chosen 4 digits (e.g. <code>1234</code>). This takes effect immediately.
        </li>
        <li><strong>Reset from Already-Paired E-Reader:</strong><br>
          Open KOReader &rarr; tap <em>Tools &rarr; Sink &rarr; Reset Pairing PIN</em>.
        </li>
        <li><strong>First-time setup?</strong><br>
          If this is your first time setting up, generate a code on your reader, type it above, and choose any 4-digit PIN below.
        </li>
      </ol>
      <div style="text-align: right; margin-top: 8px;">
        <button type="button" id="btnCloseHelp" class="btn-link" style="color: var(--text-muted);">Close ✕</button>
      </div>
    </div>

    <form id="pairForm">
      <div class="code-input-wrap">
        <input
          type="text"
          id="pairingCode"
          class="code-input"
          placeholder="CODE"
          maxlength="6"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          autofocus
        />
      </div>

      <!-- Trusted Browser Banner (shown when browser is authorized) -->
      <div id="trustedBanner" class="trusted-card" style="display: none;">
        <div>
          <span>🔒</span> <strong>Trusted Browser</strong> &middot; Pre-authorized for 1 year
        </div>
        <button type="button" id="btnRevokeTrust" class="btn-link" style="color: var(--text-muted);">Forget</button>
      </div>

      <!-- PIN Input (shown on untrusted browsers) -->
      <div class="pin-wrap" id="pinWrap">
        <div class="pin-header">
          <label for="pairingPin" class="pin-label" id="pinLabel">Pairing PIN (4 digits)</label>
          <button type="button" class="btn-link" id="btnForgotPin">Forgot PIN?</button>
        </div>
        <div class="pin-input-container">
          <input
            type="password"
            id="pairingPin"
            name="sink_device_pin"
            class="pin-input"
            placeholder="••••"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="4"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          />
          <button type="button" id="btnTogglePin" class="btn-eye" title="Toggle PIN visibility">👁</button>
        </div>
      </div>

      <div class="trust-row" id="trustRow">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
          <input type="checkbox" id="trustBrowser" checked />
          <span>Trust this browser for 1 year (no PIN on future visits)</span>
        </label>
      </div>

      <button type="submit" id="btnSubmit" class="btn-primary">
        <span id="btnText">Connect E-Reader &rarr;</span>
      </button>

      <div id="alertBox" class="alert"></div>
    </form>

    <div class="footer-help">
      <strong>How it works:</strong> KOReader generates an ephemeral 6-character code. Confirming it here securely links your e-reader to your cloud sync server.
    </div>
  </div>

  <script>
    const TOKEN_KEY = 'sink_browser_token';

    // Purge legacy plaintext PIN from localStorage immediately
    try {
      localStorage.removeItem('sink_pairing_pin');
    } catch (_) {}

    window.addEventListener('DOMContentLoaded', async () => {
      // Auto-fill code from URL query parameter ?s=CODE
      const params = new URLSearchParams(window.location.search);
      const code = (params.get('s') || '').trim().toUpperCase();
      const codeInput = document.getElementById('pairingCode');
      if (code && code.length >= 4) {
        codeInput.value = code;
      }

      let browserToken = '';
      try {
        browserToken = localStorage.getItem(TOKEN_KEY) || '';
      } catch (_) {}

      // Query server status with browser token
      try {
        const res = await fetch('/api/session/status', {
          headers: browserToken ? { 'x-browser-token': browserToken } : {}
        });
        const data = await res.json();
        if (data) {
          if (data.browser_trusted === true) {
            // Browser is already authorized for 1 year
            document.getElementById('trustedBanner').style.display = 'flex';
            document.getElementById('pinWrap').style.display = 'none';
            document.getElementById('trustRow').style.display = 'none';
            document.getElementById('serverBadge').innerText = '🔒 Trusted Device';
            document.getElementById('btnText').innerText = 'Connect E-Reader →';
          } else if (data.has_pin === false) {
            document.getElementById('serverBadge').innerText = '⚙ First-Time Setup';
            document.getElementById('stepTitle').innerText = 'Set Up Your Sink Server';
            document.getElementById('stepDesc').innerHTML = 'Enter the 6-character code from your e-reader screen, then choose a <strong>4-digit PIN</strong> below to secure your server.';
            document.getElementById('pinLabel').innerText = 'Choose a 4-Digit PIN';
            document.getElementById('btnText').innerText = 'Initialize & Connect E-Reader →';
            document.getElementById('btnForgotPin').style.display = 'none';
          } else {
            document.getElementById('serverBadge').innerText = '● Server Active';
            document.getElementById('btnForgotPin').style.display = 'inline';
          }
        }
      } catch (_) {}

      if (!codeInput.value) {
        codeInput.focus();
      } else if (document.getElementById('pinWrap').style.display !== 'none') {
        document.getElementById('pairingPin').focus();
      } else {
        document.getElementById('btnSubmit').focus();
      }
    });

    // Eye toggle for masked PIN
    document.getElementById('btnTogglePin').addEventListener('click', () => {
      const pinInput = document.getElementById('pairingPin');
      const btn = document.getElementById('btnTogglePin');
      if (pinInput.type === 'password') {
        pinInput.type = 'text';
        btn.innerText = '🔒';
      } else {
        pinInput.type = 'password';
        btn.innerText = '👁';
      }
    });

    // Forget this browser
    document.getElementById('btnRevokeTrust').addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
          await fetch('/api/session/revoke-browser', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-browser-token': token },
            body: JSON.stringify({ browser_token: token })
          });
        }
        localStorage.removeItem(TOKEN_KEY);
      } catch (_) {}
      document.getElementById('trustedBanner').style.display = 'none';
      document.getElementById('pinWrap').style.display = 'block';
      document.getElementById('trustRow').style.display = 'flex';
      document.getElementById('serverBadge').innerText = '● Server Active';
      document.getElementById('pairingPin').value = '';
      document.getElementById('pairingPin').focus();
    });

    // Toggle help panel for PIN reset
    document.getElementById('btnForgotPin').addEventListener('click', (e) => {
      e.preventDefault();
      const help = document.getElementById('forgotPinHelp');
      help.style.display = (help.style.display === 'block') ? 'none' : 'block';
    });

    document.getElementById('btnCloseHelp').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('forgotPinHelp').style.display = 'none';
    });

    document.getElementById('pairForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const alertBox = document.getElementById('alertBox');
      const btn = document.getElementById('btnSubmit');
      const btnText = document.getElementById('btnText');
      const code = document.getElementById('pairingCode').value.trim().toUpperCase();
      const pin = document.getElementById('pairingPin').value.trim();
      const isTrusted = document.getElementById('trustedBanner').style.display !== 'none';
      const trustBrowser = document.getElementById('trustBrowser').checked;

      if (!code || code.length < 4) {
        alertBox.className = 'alert error';
        alertBox.innerText = 'Please enter the 6-character code shown on your e-reader screen.';
        alertBox.style.display = 'block';
        document.getElementById('pairingCode').focus();
        return;
      }

      if (!isTrusted && (!pin || pin.length !== 4 || !/^\\d{4}$/.test(pin))) {
        alertBox.className = 'alert error';
        alertBox.innerText = 'Please enter an exact 4-digit PIN (numbers only, 0000-9999).';
        alertBox.style.display = 'block';
        document.getElementById('pairingPin').focus();
        return;
      }

      btn.disabled = true;
      btnText.innerText = 'Connecting...';
      alertBox.style.display = 'none';

      let browserToken = '';
      try {
        browserToken = localStorage.getItem(TOKEN_KEY) || '';
      } catch (_) {}

      const reqHeaders = { 'Content-Type': 'application/json' };
      if (browserToken) {
        reqHeaders['x-browser-token'] = browserToken;
      }

      const reqPayload = {
        username: 'primary_reader',
        trust_browser: trustBrowser,
      };
      if (isTrusted && browserToken) {
        reqPayload.browser_token = browserToken;
      } else {
        reqPayload.pin = pin;
      }

      try {
        const res = await fetch('/api/session/' + encodeURIComponent(code) + '/submit', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(reqPayload)
        });
        const data = await res.json().catch(() => null) || {};

        if (res.ok && data.success) {
          if (data.browser_token) {
            try {
              localStorage.setItem(TOKEN_KEY, data.browser_token);
            } catch (_) {}
            document.getElementById('trustedBanner').style.display = 'flex';
            document.getElementById('pinWrap').style.display = 'none';
            document.getElementById('trustRow').style.display = 'none';
            document.getElementById('serverBadge').innerText = '🔒 Trusted Device';
          }
          // Clear pin from input memory
          document.getElementById('pairingPin').value = '';
          alertBox.className = 'alert success';
          alertBox.innerText = '✓ Device paired successfully! Look at your e-reader screen.';
          alertBox.style.display = 'block';
          btnText.innerText = '✓ Connected!';
        } else {
          alertBox.className = 'alert error';
          alertBox.innerText = data.error || data.message || 'Invalid code or PIN. Please check your e-reader and try again.';
          alertBox.style.display = 'block';
          btn.disabled = false;
          btnText.innerText = 'Connect E-Reader →';
        }
      } catch (err) {
        alertBox.className = 'alert error';
        alertBox.innerText = 'Network error: ' + (err.message || 'Could not reach server');
        alertBox.style.display = 'block';
        btn.disabled = false;
        btnText.innerText = 'Connect E-Reader →';
      }
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

// Custom 404 handler
app.notFound((c) => {
  return c.json(
    {
      code: 404,
      message: "Endpoint not found",
    },
    404
  );
});

// Global error handler
app.onError((err, c) => {
  console.error("Unhandled server error:", err);
  return c.json(
    {
      code: KosyncErrors.INTERNAL.code,
      message: KosyncErrors.INTERNAL.message,
    },
    KosyncErrors.INTERNAL.status
  );
});

export default app;
