/**
 * Web UI: link device (QuickConnect or password), list devices, unlink, reset password.
 */
import { Router, type Request, type Response } from "express";
import * as jf from "../jellyfin/client.js";
import {
  addLinkedDevice,
  getJellyfinCredentialsForUser,
  listLinkedDevices,
  unlinkDevice,
  resetAppPassword,
  resolveToJellyfinToken,
  renameDevice,
  setJellyfinSession,
} from "../store/index.js";

const router = Router();

function getSessionUser(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const c of cookies) {
    if (c.startsWith("subfin_user=")) {
      const v = c.substring("subfin_user=".length);
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

function setSessionUser(res: Response, username: string): void {
  const encoded = encodeURIComponent(username);
  // Lightweight, HttpOnly session cookie; expires with browser session.
  res.setHeader(
    "Set-Cookie",
    `subfin_user=${encoded}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionUser(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    "subfin_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

const baseStyles = `
  :root {
    color-scheme: dark light;
    --bg: #050812;
    --bg-elevated: #0f172a;
    --bg-elevated-soft: rgba(15, 23, 42, 0.8);
    --border-subtle: rgba(148, 163, 184, 0.35);
    --accent: #38bdf8;
    --accent-soft: rgba(56, 189, 248, 0.15);
    --accent-strong: #0ea5e9;
    --danger: #f97373;
    --danger-soft: rgba(248, 113, 113, 0.12);
    --text: #e5e7eb;
    --text-muted: #9ca3af;
    --shadow-soft: 0 18px 45px rgba(15, 23, 42, 0.85);
    --radius-lg: 18px;
    --radius-xl: 26px;
  }
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
      "Inter", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(56, 189, 248, 0.22), transparent 55%),
      radial-gradient(circle at bottom right, rgba(129, 140, 248, 0.24), transparent 55%),
      radial-gradient(circle at top right, rgba(45, 212, 191, 0.18), transparent 55%),
      var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
  }
  .shell {
    width: 100%;
    max-width: 1024px;
    border-radius: 32px;
    padding: 28px 26px 26px;
    background: linear-gradient(
        145deg,
        rgba(15, 23, 42, 0.88),
        rgba(15, 23, 42, 0.98)
      ),
      radial-gradient(circle at top left, rgba(56, 189, 248, 0.12), transparent 60%),
      radial-gradient(circle at bottom right, rgba(129, 140, 248, 0.16), transparent 60%);
    box-shadow: var(--shadow-soft);
    border: 1px solid rgba(148, 163, 184, 0.35);
    backdrop-filter: blur(26px) saturate(140%);
  }
  .shell-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.28);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .brand-mark {
    width: 32px;
    height: 32px;
    border-radius: 13px;
    background:
      radial-gradient(circle at 10% 0%, rgba(248, 250, 252, 0.9), transparent 40%),
      conic-gradient(from 210deg, #38bdf8, #6366f1, #22c55e, #38bdf8);
    position: relative;
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.9),
      0 10px 22px rgba(15, 23, 42, 0.7);
  }
  .brand-mark::after {
    content: "";
    position: absolute;
    inset: 7px 6px 8px;
    border-radius: 9px;
    background:
      radial-gradient(circle at 20% 0%, rgba(248, 250, 252, 0.85), transparent 55%),
      linear-gradient(140deg, #020617, #020617 45%, #020617 55%, #020617);
    box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.28);
  }
  .brand-title {
    font-size: 1.15rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .brand-title span:last-child {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .badge {
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid rgba(148, 163, 184, 0.45);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .badge-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #22c55e;
    box-shadow: 0 0 0 5px rgba(34, 197, 94, 0.18);
  }
  .shell-main {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 22px;
    padding-top: 18px;
  }
  @media (max-width: 840px) {
    body {
      padding: 18px 10px;
    }
    .shell {
      border-radius: 22px;
      padding: 18px 18px 20px;
    }
    .shell-main {
      grid-template-columns: minmax(0, 1fr);
    }
    .shell-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 8px;
  }
  .hero-title {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .hero-subtitle {
    font-size: 0.9rem;
    color: var(--text-muted);
    max-width: 32rem;
  }
  .auth-grid,
  .dashboard-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    gap: 14px;
    margin-top: 14px;
  }
  @media (max-width: 840px) {
    .auth-grid,
    .dashboard-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .card {
    border-radius: var(--radius-lg);
    padding: 14px 14px 16px;
    background: radial-gradient(circle at top left, rgba(56, 189, 248, 0.14), transparent 55%),
      radial-gradient(circle at bottom right, rgba(129, 140, 248, 0.12), transparent 55%),
      var(--bg-elevated-soft);
    border: 1px solid rgba(148, 163, 184, 0.5);
    box-shadow: 0 14px 32px rgba(15, 23, 42, 0.9);
  }
  .card-muted {
    background: radial-gradient(circle at top, rgba(15, 23, 42, 0.4), transparent 60%),
      var(--bg-elevated-soft);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }
  .card-title {
    font-size: 0.92rem;
    font-weight: 600;
  }
  .card-kicker {
    font-size: 0.75rem;
    color: var(--accent);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .card-body {
    font-size: 0.82rem;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  form {
    margin: 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  input[type="text"],
  input[type="password"] {
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    padding: 7px 11px;
    font-size: 0.82rem;
    background: rgba(15, 23, 42, 0.95);
    color: var(--text);
    outline: none;
    transition: border-color 0.13s ease, box-shadow 0.13s ease, background 0.13s ease;
  }
  input[type="text"]::placeholder,
  input[type="password"]::placeholder {
    color: rgba(148, 163, 184, 0.8);
  }
  input[type="text"]:focus,
  input[type="password"]:focus {
    border-color: var(--accent-strong);
    box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.5), 0 8px 22px rgba(15, 23, 42, 0.8);
    background: rgba(15, 23, 42, 0.98);
  }
  .field-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .field-grow {
    flex: 1 1 140px;
  }
  .actions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-start;
  }
  button {
    cursor: pointer;
    border-radius: 999px;
    border: none;
    padding: 7px 14px;
    font-size: 0.8rem;
    font-weight: 500;
    letter-spacing: 0.03em;
    text-transform: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: linear-gradient(135deg, var(--accent), var(--accent-strong));
    color: #0b1120;
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.9),
      0 12px 22px rgba(8, 47, 73, 0.9);
    transition: transform 0.09s ease, box-shadow 0.09s ease, filter 0.12s ease;
  }
  button:hover {
    filter: brightness(1.05);
    transform: translateY(-1px);
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.9),
      0 16px 26px rgba(8, 47, 73, 0.95);
  }
  button:active {
    transform: translateY(0);
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.9),
      0 8px 18px rgba(8, 47, 73, 0.9);
  }
  .btn-secondary {
    background: rgba(15, 23, 42, 0.96);
    color: var(--text);
    border: 1px solid var(--border-subtle);
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.95),
      0 10px 20px rgba(15, 23, 42, 0.85);
  }
  .btn-secondary:hover {
    filter: none;
    background: rgba(15, 23, 42, 0.98);
  }
  .btn-danger {
    background: linear-gradient(135deg, #fb7185, #f97373);
    color: #0f172a;
    box-shadow:
      0 0 0 1px rgba(15, 23, 42, 0.95),
      0 10px 20px rgba(127, 29, 29, 0.9);
  }
  .btn-small {
    padding: 5px 11px;
    font-size: 0.75rem;
  }
  a {
    color: var(--accent);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .divider {
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(148, 163, 184, 0.45),
      transparent
    );
    margin: 12px 0;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .meta strong {
    color: var(--text);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 0.72rem;
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(15, 23, 42, 0.9);
  }
  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.8);
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 280px;
    overflow: auto;
  }
  .list-item {
    border-radius: 12px;
    padding: 8px 9px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.5);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list-item-main {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    font-size: 0.8rem;
  }
  .list-item-label {
    font-weight: 500;
  }
  .list-item-meta {
    font-size: 0.74rem;
    color: var(--text-muted);
  }
  .list-item-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }
  .list-item-fields {
    display: flex;
    flex-direction: row;
    gap: 6px;
    align-items: center;
    width: 100%;
  }
  .tiny {
    font-size: 0.72rem;
    color: var(--text-muted);
  }
`;

function renderLayout(title: string, innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${baseStyles}</style>
</head>
<body>
  <div class="shell">
    ${innerHtml}
  </div>
</body>
</html>`;
}

function renderDashboardHeader(sessionUser: string | null): string {
  const userLabel = sessionUser
    ? `<div style="display:flex; align-items:center; gap:10px;">
         <div class="badge"><span class="badge-dot"></span><span>Signed in as <strong>${escapeHtml(
           sessionUser
         )}</strong></span></div>
         <form method="post" action="/web/logout" style="margin:0;">
           <button type="submit" class="btn-secondary btn-small">Log out</button>
         </form>
       </div>`
    : `<div class="badge"><span class="badge-dot"></span><span>Ready to link Subsonic clients</span></div>`;
  return `
    <header class="shell-header">
      <div class="brand">
        <div class="brand-mark"></div>
        <div class="brand-title">
          <span>Subfin</span>
          <span>OpenSubsonic → Jellyfin bridge</span>
        </div>
      </div>
      ${userLabel}
    </header>
  `;
}

router.get("/", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  const devices = sessionUser ? listLinkedDevices(sessionUser) : [];

  const hero = `
    <section class="hero">
      <div class="hero-title">${
        sessionUser ? "Devices linked to Subfin" : "Link Jellyfin to Subsonic clients"
      }</div>
      <p class="hero-subtitle">
        ${
          sessionUser
            ? "See devices that already have access, or create a new app password for another client."
            : "Sign in with Jellyfin, then use app passwords in your Subsonic/OpenSubsonic clients. Tested and mostly functional with Castafiore, Dsub2000, musly, Navic, Tempus, and Youamp! Bugs guaranteed."
        }
      </p>
    </section>
  `;

  const dashboard =
    sessionUser && devices
      ? renderAuthenticatedDashboard(sessionUser, devices)
      : renderLoginPanels();

  res.send(
    renderLayout(
      "Subfin",
      `
        ${renderDashboardHeader(sessionUser)}
        <main class="shell-main">
          <div>
            ${hero}
            ${dashboard}
          </div>
        </main>
      `
    )
  );
});

function renderLoginPanels(): string {
  return `
    <section class="auth-grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">Jellyfin sign-in</div>
            <div class="card-title">Quick Connect (recommended)</div>
          </div>
        </div>
        <div class="card-body">
          Use Jellyfin Quick Connect on a device where you are already logged in. Subfin
          will never see your Jellyfin password — only a scoped access token.
        </div>
        <div class="actions-row">
          <a href="/auth/quickconnect"><button type="button">Continue</button></a>
          <span class="tiny">In Jellyfin: Settings → Quick Connect</span>
        </div>
      </div>
      <div class="card card-muted">
        <div class="card-header">
          <div>
            <div class="card-kicker">Alternative</div>
            <div class="card-title">Username & password</div>
          </div>
        </div>
        <div class="card-body">
          Sign in with your Jellyfin username and password, then manage or link Subsonic/OpenSubsonic clients.
        </div>
        <form method="post" action="/web/link/password" class="stack">
          <div class="stack">
            <label>
              Jellyfin username
              <input name="username" autocomplete="username" required>
            </label>
            <label>
              Password
              <input type="password" name="password" autocomplete="current-password" required>
            </label>
          </div>
          <div class="actions-row">
            <button type="submit">Continue</button>
            <span class="tiny">You’ll see device management and app passwords after signing in.</span>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderAuthenticatedDashboard(
  sessionUser: string,
  devices: ReturnType<typeof listLinkedDevices>
): string {
  const listItems =
    devices.length === 0
      ? `<div class="tiny">No devices linked yet. Generate your first app password below.</div>`
      : devices
          .map(
            (d) => `
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-label">
            ${d.device_label ? escapeHtml(d.device_label) : "Unnamed device"}
          </div>
          <div class="pill">
            <span class="pill-dot"></span>
            <span>ID #${d.id}</span>
          </div>
        </div>
        <div class="list-item-meta">Linked ${escapeHtml(d.created_at)}</div>
        <div class="list-item-actions">
          <form method="post" action="/web/devices/rename">
            <div class="list-item-fields">
              <input type="hidden" name="deviceId" value="${d.id}">
              <input
                type="text"
                name="deviceLabel"
                value="${d.device_label ? escapeHtml(d.device_label) : ""}"
                placeholder="Rename device (optional)"
                style="flex: 1 1 auto; min-width: 0;"
              >
              <button type="submit" class="btn-secondary btn-small" style="flex: 0 0 auto; white-space: nowrap;">Save label</button>
            </div>
          </form>
          <form method="post" action="/web/devices/reset">
            <input type="hidden" name="deviceId" value="${d.id}">
            <button type="submit" class="btn-secondary btn-small">Reset app password</button>
          </form>
          <form method="post" action="/web/devices/unlink">
            <input type="hidden" name="deviceId" value="${d.id}">
            <button type="submit" class="btn-danger btn-small">Unlink</button>
          </form>
        </div>
      </li>`
          )
          .join("");

  return `
    <section class="dashboard-grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">New client</div>
            <div class="card-title">Generate app password</div>
          </div>
        </div>
        <div class="card-body">
          Create a new app-specific password for another Subsonic/OpenSubsonic client while
          staying signed in as <strong>${escapeHtml(sessionUser)}</strong>.
        </div>
        <form method="post" action="/web/link/new-device" class="stack">
          <label>
            Device label (optional)
            <input
              type="text"
              name="deviceLabel"
              placeholder="e.g. Work laptop, Car, Living room"
            >
          </label>
          <div class="actions-row">
            <button type="submit">Generate app password</button>
            <span class="tiny">You’ll see the new password once — copy it into your client.</span>
          </div>
        </form>
      </div>
      <div class="card card-muted">
        <div class="card-header">
          <div>
            <div class="card-kicker">Linked devices</div>
            <div class="card-title">Manage access</div>
          </div>
        </div>
        <div class="card-body">
          Rename devices to keep things tidy, reset app passwords if a device is compromised,
          or unlink devices you no longer use.
        </div>
        <ul class="list">
          ${listItems}
        </ul>
      </div>
    </section>
  `;
}

// Legacy entry point; keep for compatibility but send users to the main overview.
router.get("/link", (_req: Request, res: Response) => {
  res.redirect("/");
});

router.get("/auth/quickconnect", async (_req: Request, res: Response) => {
  const result = await jf.initiateQuickConnect();
  if (!result) {
    res.status(500).send("Quick Connect not available. Is Jellyfin reachable and Quick Connect enabled?");
    return;
  }
  res.send(`
${renderLayout(
  "Quick Connect - Subfin",
  `
    ${renderDashboardHeader(null)}
    <main class="shell-main">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">Jellyfin</div>
            <div class="card-title">Quick Connect</div>
          </div>
        </div>
        <div class="card-body">
          <p>Enter this code in Jellyfin on a device where you are already signed in:</p>
          <p style="font-size:2.2rem; letter-spacing:0.22em; font-weight:600; margin: 8px 0 4px;">
            ${escapeHtml(result.code)}
          </p>
          <p class="tiny">In Jellyfin: <strong>Settings → Quick Connect</strong>.</p>
        </div>
        <div class="divider"></div>
        <div class="actions-row">
          <span class="pill"><span class="pill-dot"></span><span id="status">Waiting for authorization…</span></span>
          <a href="/"><button type="button" class="btn-secondary btn-small">Back to overview</button></a>
        </div>
      </div>
      <aside>
        <div class="card card-muted">
          <div class="card-header">
            <div class="card-title">What happens next?</div>
          </div>
          <div class="card-body">
            Once Jellyfin confirms this Quick Connect request, Subfin will:
            <ul style="padding-left: 18px; margin: 8px 0 0;">
              <li>Link your Jellyfin account to Subfin.</li>
              <li>Sign you into the Subfin web UI.</li>
              <li>Send you to device management where you can create app passwords.</li>
            </ul>
          </div>
        </div>
      </aside>
    </main>
    <script>
      const secret = ${JSON.stringify(result.secret)};
      const poll = async () => {
        const r = await fetch('/web/quickconnect/poll?secret=' + encodeURIComponent(secret));
        const d = await r.json();
        if (d.authenticated) {
          window.location = '/web/quickconnect/done?secret=' + encodeURIComponent(secret);
          return;
        }
        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.textContent = 'Still waiting…';
        setTimeout(poll, 2000);
      };
      poll();
    </script>
  `
)}`);
});

// Legacy path; keep for compatibility but prefer /auth/quickconnect.
router.get("/link/quickconnect", (_req: Request, res: Response) => {
  res.redirect("/auth/quickconnect");
});

router.get("/web/quickconnect/poll", async (req: Request, res: Response) => {
  const secret = (req.query.secret as string)?.trim();
  if (!secret) {
    res.status(400).json({ authenticated: false });
    return;
  }
  const state = await jf.getQuickConnectState(secret);
  res.json({ authenticated: state.authenticated });
});

router.get("/web/quickconnect/done", async (req: Request, res: Response) => {
  const secret = (req.query.secret as string)?.trim();
  if (!secret) {
    res.redirect("/link?error=missing");
    return;
  }
  const auth = await jf.authenticateWithQuickConnect(secret);
  if (!auth) {
    res.redirect("/link?error=auth");
    return;
  }
  const username = (await jf.getCurrentUserName(auth.accessToken)) ?? auth.userId;
  // Auth-only step: remember Jellyfin credentials for this Subsonic username.
  setJellyfinSession(username, auth.userId, auth.accessToken);
  setSessionUser(res, username);
  // After auth, take the user to device management where they can link devices.
  res.redirect("/devices");
});

router.get("/auth/password", (_req: Request, res: Response) => {
  res.send(`
${renderLayout(
  "Sign in with password - Subfin",
  `
    ${renderDashboardHeader(null)}
    <main class="shell-main">
      <div>
        <section class="hero">
          <div class="hero-title">Sign in to Jellyfin</div>
          <p class="hero-subtitle">
            Use your Jellyfin username and password to authenticate with Subfin.
          </p>
        </section>
        <div class="card" style="margin-top: 14px;">
          <form method="post" action="/web/link/password" class="stack">
            <div class="stack">
              <label>
                Jellyfin username
                <input name="username" autocomplete="username" required>
              </label>
              <label>
                Password
                <input type="password" name="password" autocomplete="current-password" required>
              </label>
            </div>
            <div class="actions-row">
              <button type="submit">Continue</button>
              <a href="/"><button type="button" class="btn-secondary">Back to overview</button></a>
            </div>
          </form>
        </div>
      </div>
      <aside>
        <div class="card card-muted">
          <div class="card-header">
            <div class="card-title">Prefer not to share your password?</div>
          </div>
          <div class="card-body">
            Use <a href="/link/quickconnect">Quick Connect</a> instead — Jellyfin will issue a token
            without Subfin ever seeing your password.
          </div>
        </div>
      </aside>
    </main>
  `
)}`);
});

// Legacy path; keep for compatibility but prefer /auth/password.
router.get("/link/password", (_req: Request, res: Response) => {
  res.redirect("/auth/password");
});

router.post("/web/link/password", async (req: Request, res: Response) => {
  const username = (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  if (!username || !password) {
    res.redirect("/link/password?error=missing");
    return;
  }
  const auth = await jf.authenticateByName(username, password);
  if (!auth) {
    res.redirect("/link/password?error=wrong");
    return;
  }
  // Auth-only step: remember Jellyfin credentials for this Subsonic username.
  setJellyfinSession(username, auth.userId, auth.accessToken);
  setSessionUser(res, username);
  // After auth, take the user to device management where they can link devices.
  res.redirect("/devices");
});

router.post("/web/link/new-device", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/link");
    return;
  }
  const creds = getJellyfinCredentialsForUser(sessionUser);
  if (!creds) {
    res.redirect("/link?error=no-device");
    return;
  }
  const deviceLabel = (req.body?.deviceLabel as string | undefined)?.trim() || undefined;
  const appPassword = addLinkedDevice(
    sessionUser,
    creds.jellyfinUserId,
    creds.jellyfinAccessToken,
    deviceLabel
  );
  res.send(`
${renderLayout(
  "Device linked - Subfin",
  `
    ${renderDashboardHeader(sessionUser)}
    <main class="shell-main">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">New app password</div>
            <div class="card-title">Another device linked</div>
          </div>
        </div>
        <div class="card-body">
          <p>Use these credentials in your Subsonic/OpenSubsonic client:</p>
          <ul style="padding-left: 18px; margin: 8px 0;">
            <li><strong>Username:</strong> ${escapeHtml(sessionUser)}</li>
            <li><strong>Password (app password):</strong> <code>${escapeHtml(appPassword)}</code></li>
            ${deviceLabel ? `<li><strong>Device label:</strong> ${escapeHtml(deviceLabel)}</li>` : ""}
          </ul>
          <p class="tiny">Copy the password now; it will not be shown again.</p>
        </div>
        <div class="actions-row">
          <a href="/"><button type="button">Back to overview</button></a>
          <a href="/devices"><button type="button" class="btn-secondary">Manage linked devices</button></a>
          <a href="/link"><button type="button" class="btn-secondary">Link another device</button></a>
        </div>
      </div>
      <aside>
        <div class="card card-muted">
          <div class="card-header">
            <div class="card-title">Tip</div>
          </div>
          <div class="card-body">
            You can generate separate app passwords for each client (phone, desktop, car).
            This makes it easier to revoke access for a single device later.
          </div>
        </div>
      </aside>
    </main>
  `
)}`);
});

router.get("/devices", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (sessionUser) {
    const devices = listLinkedDevices(sessionUser);
    res.send(
      renderLayout(
        "My devices - Subfin",
        `
          ${renderDashboardHeader(sessionUser)}
          <main class="shell-main">
            ${renderAuthenticatedDashboard(sessionUser, devices)}
          </main>
        `
      )
    );
    return;
  }

  // No session: show login form.
  res.send(`
${renderLayout(
  "Manage devices - Subfin",
  `
    ${renderDashboardHeader(null)}
    <main class="shell-main">
      <div>
        <section class="hero">
          <div class="hero-title">Manage linked devices</div>
          <p class="hero-subtitle">
            Sign in with your Subsonic username and app password to review existing devices,
            reset app passwords, or revoke access.
          </p>
        </section>
        <div class="card" style="margin-top: 14px;">
          <form method="post" action="/web/devices" class="stack">
            <label>
              Subsonic username
              <input name="username" autocomplete="username" required>
            </label>
            <label>
              App password
              <input type="password" name="password" autocomplete="current-password" required>
            </label>
            <div class="actions-row">
              <button type="submit">View my devices</button>
              <a href="/"><button type="button" class="btn-secondary">Back to overview</button></a>
            </div>
          </form>
        </div>
      </div>
      <aside>
        <div class="card card-muted">
          <div class="card-header">
            <div class="card-title">Need to create an app password?</div>
          </div>
          <div class="card-body">
            Head back to the main view and link a device with Jellyfin Quick Connect or username
            & password to get your first app password.
          </div>
          <div class="actions-row">
            <a href="/"><button type="button" class="btn-secondary">Open main view</button></a>
          </div>
        </div>
      </aside>
    </main>
  `
)}`);
});

router.post("/web/devices", async (req: Request, res: Response) => {
  const username = (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  if (!username || !password) {
    res.redirect("/devices?error=missing");
    return;
  }
  const token = resolveToJellyfinToken(username, password);
  if (!token) {
    res.redirect("/devices?error=wrong");
    return;
  }
  setSessionUser(res, username);
  const devices = listLinkedDevices(username);
  res.send(
    renderLayout(
      "My devices - Subfin",
      `
        ${renderDashboardHeader(username)}
        <main class="shell-main">
          ${renderAuthenticatedDashboard(username, devices)}
        </main>
      `
    )
  );
});

router.post("/web/devices/unlink", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  const username = sessionUser || (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  if (!username || (!sessionUser && password === undefined) || isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }
  if (!sessionUser) {
    if (!password) {
      res.redirect("/devices?error=missing");
      return;
    }
    const token = resolveToJellyfinToken(username, password);
    if (!token) {
      res.redirect("/devices?error=wrong");
      return;
    }
  }
  const ok = unlinkDevice(deviceId, username);
  res.redirect(ok ? "/devices?unlinked=1" : "/devices?error=unlink");
});

router.post("/web/devices/reset", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  const username = sessionUser || (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  if (!username || (!sessionUser && password === undefined) || isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }
  if (!sessionUser) {
    if (!password) {
      res.redirect("/devices?error=missing");
      return;
    }
    const token = resolveToJellyfinToken(username, password);
    if (!token) {
      res.redirect("/devices?error=wrong");
      return;
    }
  }
  const newPassword = resetAppPassword(deviceId, username);
  if (!newPassword) {
    res.redirect("/devices?error=reset");
    return;
  }
  res.send(`
${renderLayout(
  "New password - Subfin",
  `
    ${renderDashboardHeader(username)}
    <main class="shell-main">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">App password reset</div>
            <div class="card-title">New app password issued</div>
          </div>
        </div>
        <div class="card-body">
          <p>New app password for this device:</p>
          <p><code>${escapeHtml(newPassword)}</code></p>
          <p class="tiny">
            Update your Subsonic/OpenSubsonic client with this password. The old app password no longer works.
          </p>
        </div>
        <div class="actions-row">
          <a href="/devices"><button type="button" class="btn-secondary">Back to devices</button></a>
          <a href="/"><button type="button">Back to overview</button></a>
        </div>
      </div>
    </main>
  `
)}`);
});

router.post("/web/devices/rename", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  const username = sessionUser || (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  const rawLabel = (req.body?.deviceLabel as string | undefined) ?? "";
  const deviceLabel = rawLabel.trim() === "" ? null : rawLabel.trim();

  if (!username || (!sessionUser && password === undefined) || isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }
  if (!sessionUser) {
    if (!password) {
      res.redirect("/devices?error=missing");
      return;
    }
    const token = resolveToJellyfinToken(username, password);
    if (!token) {
      res.redirect("/devices?error=wrong");
      return;
    }
  }

  const ok = renameDevice(deviceId, username, deviceLabel);
  res.redirect(ok ? "/devices?renamed=1" : "/devices?error=rename");
});

router.post("/web/logout", (req: Request, res: Response) => {
  clearSessionUser(res);
  res.redirect("/");
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { router as webRouter };
