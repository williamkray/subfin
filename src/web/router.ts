/**
 * Web UI: link device (QuickConnect or password), list devices, unlink, reset password, share page.
 */
import archiver from "archiver";
import axios from "axios";
import { Router, type Request, type Response } from "express";
import * as jf from "../jellyfin/client.js";
import { config } from "../config.js";
import {
  addLinkedDevice,
  getJellyfinCredentialsForUser,
  getJellyfinCredentialsForLinking,
  getDeviceJellyfinToken,
  listLinkedDevices,
  unlinkDevice,
  resetAppPassword,
  resolveToJellyfinToken,
  renameDevice,
  setJellyfinSession,
  resolveShareAuth,
  getShareByUid,
  getShareAuthByUid,
  incrementShareVisitCount,
  getSharesForUser,
  deleteShare,
  updateShare,
} from "../store/index.js";
import { toJellyfinContext, type AuthResult } from "../subsonic/auth.js";
import { handleCreateShare, handleSearch3 } from "../subsonic/handlers.js";
import { shareEndpointRateLimit, recordShareAuthFailure } from "./share-rate-limit.js";
import { setShareCookie, getShareSessionFromCookie, clearShareCookie } from "./share-session.js";
import { createShareToken } from "./share-tokens.js";

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

/** Parse Jellyfin web UI URL and return the item id (e.g. from #/details?id=xxx or ?id=xxx). */
function parseJellyfinItemIdFromUrl(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const fromQuery = url.searchParams.get("id");
    if (fromQuery) return fromQuery.trim() || null;
    const hash = url.hash || "";
    const hashParams = new URLSearchParams(hash.replace(/^#?\/?[^?]*\?/, ""));
    return hashParams.get("id")?.trim() || null;
  } catch {
    return null;
  }
}

/** Build AuthResult from session for server-side API calls (createShare, search). */
function getAuthFromSession(req: Request): AuthResult | null {
  const user = getSessionUser(req);
  if (!user) return null;
  const creds = getJellyfinCredentialsForUser(user);
  if (!creds) return null;
  return {
    subsonicUsername: user,
    jellyfinUserId: creds.jellyfinUserId,
    jellyfinAccessToken: creds.jellyfinAccessToken,
  };
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
  .shell-main-full {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-width: 0;
  }
  .shell-main-full .dashboard-grid {
    margin-top: 0;
  }
  .create-share-search-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }
  .create-share-search-row input[type="text"] {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
  }
  .create-share-url-input {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }
  .search-result-section {
    font-weight: 700;
    font-size: 0.8rem;
    margin-top: 12px;
    margin-bottom: 4px;
    color: var(--text);
  }
  .search-result-section:first-child {
    margin-top: 0;
  }
  .search-results-list {
    max-height: 280px;
    overflow-y: auto;
    min-width: 0;
  }
  .search-result-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    cursor: pointer;
  }
  .search-result-row input[type="checkbox"] {
    flex-shrink: 0;
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
  input[type="password"],
  input[type="url"] {
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
  input[type="password"]::placeholder,
  input[type="url"]::placeholder {
    color: rgba(148, 163, 184, 0.8);
  }
  input[type="text"]:focus,
  input[type="password"]:focus,
  input[type="url"]:focus {
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
  .editable-label {
    cursor: pointer;
    border-bottom: 1px dotted var(--text-muted);
    padding: 2px 0;
  }
  .editable-label:hover {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .label-edit-inline {
    display: none;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .label-edit-inline.editing {
    display: flex;
  }
  .label-edit-inline input[type="text"] {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 240px;
  }
  .label-display-wrap.editing .label-display {
    display: none;
  }
  .label-display-wrap.editing .label-edit-inline {
    display: flex;
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

function renderDashboardHeader(sessionUser: string | null, opts?: { backToDevices?: boolean }): string {
  const navLink =
    opts?.backToDevices && sessionUser
      ? `<a href="/devices" class="btn-secondary btn-small" style="text-decoration:none;">Devices</a>`
      : sessionUser
        ? `<a href="/create-share" class="btn-secondary btn-small" style="text-decoration:none;">Create share</a>`
        : "";
  const userLabel = sessionUser
    ? `<div style="display:flex; align-items:center; gap:10px;">
         ${navLink}
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

  const err = (req.query.error as string) || "";
  const loginFlash =
    !sessionUser && err
      ? (err === "auth"
          ? '<p class="card card-muted" style="margin-bottom: 14px; border-left: 4px solid #b91c1c;">Quick Connect failed or was denied. Try again.</p>'
          : err === "missing"
            ? '<p class="card card-muted" style="margin-bottom: 14px; border-left: 4px solid #b91c1c;">Session expired or invalid. Start again from the overview.</p>'
            : err === "no-device"
              ? '<p class="card card-muted" style="margin-bottom: 14px;">Link a device first from the overview, then you can add more from here.</p>'
              : "")
      : "";

  const shares = sessionUser ? getSharesForUser(sessionUser) : [];
  const dashboard =
    sessionUser && devices
      ? renderAuthenticatedDashboard(sessionUser, devices, shares)
      : renderLoginPanels();

  res.send(
    renderLayout(
      "Subfin",
      `
        ${renderDashboardHeader(sessionUser)}
        <main class="shell-main">
          <div class="shell-main-full">
            ${loginFlash}
            ${hero}
            ${dashboard}
          </div>
        </main>
      `
    )
  );
});

const LINK_DEVICE_CARD_BODY = `
  Use Jellyfin Quick Connect on a device where you are already logged in. You'll
  get one app password for this device — each link is a unique token from Jellyfin.`;

function renderLoginPanels(): string {
  return `
    <section class="auth-grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">New client</div>
            <div class="card-title">Link device</div>
          </div>
        </div>
        <div class="card-body">
          ${LINK_DEVICE_CARD_BODY}
        </div>
        <form method="get" action="/auth/quickconnect" class="stack">
          <input type="hidden" name="intent" value="link">
          <label>
            Device label (optional)
            <input type="text" name="deviceLabel" placeholder="e.g. Work laptop, Car, Living room">
          </label>
          <div class="actions-row">
            <button type="submit">Continue</button>
            <span class="tiny">In Jellyfin: Settings → Quick Connect</span>
          </div>
        </form>
      </div>
      <div class="card card-muted">
        <div class="card-header">
          <div>
            <div class="card-kicker">Existing clients</div>
            <div class="card-title">Manage devices</div>
          </div>
        </div>
        <div class="card-body">
          Sign in with Quick Connect to view linked devices, rename them, reset app passwords, or unlink.
        </div>
        <div class="actions-row">
          <a href="/auth/quickconnect?intent=manage"><button type="button">Continue</button></a>
          <span class="tiny">You'll be asked to approve the login in Jellyfin.</span>
        </div>
      </div>
    </section>
  `;
}

function renderAuthenticatedDashboard(
  sessionUser: string,
  devices: ReturnType<typeof listLinkedDevices>,
  shares: ReturnType<typeof getSharesForUser>
): string {
  const shareDeviceIds = new Set(shares.map((s) => s.linked_device_id));
  const regularDevices = devices.filter((d) => !shareDeviceIds.has(d.id));
  const listItems =
    regularDevices.length === 0
      ? `<div class="tiny">No devices linked yet. Generate your first app password below.</div>`
      : regularDevices
          .map(
            (d) => {
              const label = d.device_label ? escapeHtml(d.device_label) : "Unnamed device";
              const labelValue = d.device_label ? escapeHtml(d.device_label) : "";
              return `
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-label label-display-wrap">
            <span class="label-display editable-label" tabindex="0" role="button" title="Click to rename">${label}</span>
            <form method="post" action="/web/devices/rename" class="label-edit-inline">
              <input type="hidden" name="deviceId" value="${d.id}">
              <input type="text" name="deviceLabel" value="${labelValue}" placeholder="Device name" data-initial="${escapeHtml(labelValue)}">
              <button type="submit" class="btn-secondary btn-small label-save-btn" style="display:none;">Save</button>
            </form>
          </div>
          <div class="pill">
            <span class="pill-dot"></span>
            <span>ID #${d.id}</span>
          </div>
        </div>
        <div class="list-item-meta">Linked ${escapeHtml(d.created_at)}</div>
        <div class="list-item-actions">
          <form method="post" action="/web/devices/reset">
            <input type="hidden" name="deviceId" value="${d.id}">
            <button type="submit" class="btn-secondary btn-small">Reset app password</button>
          </form>
          <form method="post" action="/web/devices/unlink">
            <input type="hidden" name="deviceId" value="${d.id}">
            <button type="submit" class="btn-danger btn-small">Unlink</button>
          </form>
        </div>
      </li>`;
            }
          )
          .join("");

  const shareItems =
    shares.length === 0
      ? `<div class="tiny">No shares yet. Create one from <a href="/create-share">Create share</a> or from a Subsonic client.</div>`
      : shares
          .map(
            (s) => {
              const desc = s.description || `Share ${s.share_uid.slice(0, 8)}`;
              const descValue = s.description ? escapeHtml(s.description) : "";
              return `
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-label label-display-wrap">
            <span class="label-display editable-label" tabindex="0" role="button" title="Click to rename">${escapeHtml(desc)}</span>
            <form method="post" action="/web/shares/update" class="label-edit-inline">
              <input type="hidden" name="share_uid" value="${escapeHtml(s.share_uid)}">
              <input type="text" name="description" value="${descValue}" placeholder="Share name" data-initial="${escapeHtml(descValue)}">
              <button type="submit" class="btn-secondary btn-small label-save-btn" style="display:none;">Save</button>
            </form>
          </div>
        </div>
        <div class="list-item-meta">Created ${escapeHtml(s.created_at)}</div>
        <div class="list-item-actions">
          ${
            s.fullUrl
              ? `<div class="list-item-fields" style="margin-bottom:8px;">
              <label class="tiny">Share link (copy and send)</label>
              <div class="actions-row" style="margin-top:4px;">
                <input type="text" readonly value="${escapeHtml(s.fullUrl)}" style="flex:1 1 auto; min-width:0; font-size:0.75rem;">
                <button type="button" class="btn-secondary btn-small copy-share-url" data-url="${escapeHtml(s.fullUrl)}">Copy</button>
              </div>
            </div>`
              : `<p class="tiny">Full link was shown when the share was created.</p>`
          }
          <form method="post" action="/web/shares/delete" style="margin-top:6px;">
            <input type="hidden" name="share_uid" value="${escapeHtml(s.share_uid)}">
            <button type="submit" class="btn-danger btn-small">Unshare</button>
          </form>
        </div>
      </li>`;
            }
          )
          .join("");

  return `
    <section class="dashboard-grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">New client</div>
            <div class="card-title">Link device</div>
          </div>
        </div>
        <div class="card-body">
          ${LINK_DEVICE_CARD_BODY}
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
            <button type="submit">Continue</button>
            <span class="tiny">You'll be asked to approve in Jellyfin (Settings → Quick Connect). Then you'll see the new app password — copy it into your client.</span>
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
      <div class="card card-muted" style="grid-column: 1 / -1;">
        <div class="card-header">
          <div>
            <div class="card-kicker">Shares</div>
            <div class="card-title">Share links</div>
          </div>
        </div>
        <div class="card-body">
          Public links you created (playlist, album, etc.). Copy the link to send; use Unshare to revoke.
        </div>
        <ul class="list">
          ${shareItems}
        </ul>
        ${
          shares.some((s) => s.fullUrl)
            ? `<script>document.querySelectorAll('.copy-share-url').forEach(function(b){b.addEventListener('click',function(){navigator.clipboard.writeText(b.getAttribute('data-url'));b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1500);});});</script>`
            : ""
        }
      </div>
    </section>
    <script>
(function() {
  function initEditableLabels() {
    document.querySelectorAll('.label-display-wrap').forEach(function(wrap) {
      var display = wrap.querySelector('.label-display');
      var form = wrap.querySelector('.label-edit-inline');
      var input = form && form.querySelector('input[type="text"]');
      var saveBtn = form && form.querySelector('.label-save-btn');
      if (!display || !form || !input) return;
      function toEdit() {
        wrap.classList.add('editing');
        input.value = input.getAttribute('data-initial') || '';
        input.focus();
        if (saveBtn) saveBtn.style.display = (input.value !== (input.getAttribute('data-initial') || '')) ? '' : 'none';
      }
      function fromEdit() {
        if (input.value === (input.getAttribute('data-initial') || '')) wrap.classList.remove('editing');
      }
      display.addEventListener('click', toEdit);
      display.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toEdit(); } });
      input.addEventListener('input', function() { saveBtn.style.display = (input.value !== (input.getAttribute('data-initial') || '')) ? '' : 'none'; });
      input.addEventListener('blur', fromEdit);
    });
  }
  initEditableLabels();
})();
    </script>
  `;
}

function renderDeviceLinkedPage(
  sessionUser: string,
  appPassword: string,
  deviceLabel?: string
): string {
  return renderLayout(
    "Device linked - Subfin",
    `
    ${renderDashboardHeader(sessionUser)}
    <main class="shell-main">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-kicker">New app password</div>
            <div class="card-title">Device linked</div>
          </div>
        </div>
        <div class="card-body">
          <p>Use these credentials in your Subsonic/OpenSubsonic client:</p>
          <ul style="padding-left: 18px; margin: 8px 0;">
            <li><strong>Username:</strong> ${escapeHtml(sessionUser)}</li>
            <li>
              <strong>Password (app password):</strong>
              <span class="actions-row" style="display:inline-flex; align-items:center; gap:8px;">
                <code id="device-password-value">${escapeHtml(appPassword)}</code>
                <button type="button" id="device-password-copy" class="btn-secondary btn-small">Copy</button>
              </span>
            </li>
            ${deviceLabel ? `<li><strong>Device label:</strong> ${escapeHtml(deviceLabel)}</li>` : ""}
          </ul>
          <p class="tiny">Copy the password now; it will not be shown again.</p>
        </div>
        <script>
          document.getElementById('device-password-copy').addEventListener('click', function() {
            var el = document.getElementById('device-password-value');
            var t = el && el.textContent ? el.textContent.trim() : '';
            if (t) navigator.clipboard.writeText(t).then(function() {
              var btn = document.getElementById('device-password-copy');
              if (btn) { btn.textContent = 'Copied'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
            });
          });
        </script>
        <div class="actions-row">
          <a href="/"><button type="button">Back to overview</button></a>
          <a href="/devices"><button type="button" class="btn-secondary">Manage linked devices</button></a>
          <a href="/devices"><button type="button" class="btn-secondary">Link another device</button></a>
        </div>
      </div>
      <aside>
        <div class="card card-muted">
          <div class="card-header">
            <div class="card-title">Tip</div>
          </div>
          <div class="card-body">
            Each linked device has its own token. Use "Link another device" on the main page for each new client.
          </div>
        </div>
      </aside>
    </main>
  `
  );
}

// Legacy entry point; keep for compatibility but send users to the main overview.
router.get("/link", (_req: Request, res: Response) => {
  res.redirect("/");
});

router.get("/auth/quickconnect", async (req: Request, res: Response) => {
  const intent = (req.query.intent as string) === "link" ? "link" : "manage";
  const deviceLabel = (req.query.deviceLabel as string)?.trim() || undefined;
  const result = await jf.initiateQuickConnect();
  if (!result) {
    res.status(500).send("Quick Connect not available. Is Jellyfin reachable and Quick Connect enabled?");
    return;
  }
  const whatNext =
    intent === "link"
      ? "<li>Create one linked device with a unique token.</li><li>Show you an app password to use in your Subsonic client.</li>"
      : "<li>Sign you into the Subfin web UI.</li><li>Take you to device management (rename, reset, unlink).</li>";
  res.send(`
${renderLayout(
  intent === "link" ? "Link device - Subfin" : "Manage devices - Subfin",
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
              ${whatNext}
            </ul>
          </div>
        </div>
      </aside>
    </main>
    <script>
      const secret = ${JSON.stringify(result.secret)};
      const intent = ${JSON.stringify(intent)};
      const deviceId = ${JSON.stringify(result.deviceId)};
      const deviceName = ${JSON.stringify(result.deviceName)};
      const deviceLabel = ${JSON.stringify(deviceLabel ?? "")};
      const poll = async () => {
        const r = await fetch('/web/quickconnect/poll?secret=' + encodeURIComponent(secret));
        const d = await r.json();
        if (d.authenticated) {
          const params = new URLSearchParams({ secret, intent, deviceId, deviceName });
          if (deviceLabel) params.set('deviceLabel', deviceLabel);
          window.location = '/web/quickconnect/done?' + params.toString();
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
  const intent = (req.query.intent as string) === "link" ? "link" : "manage";
  const deviceId = (req.query.deviceId as string)?.trim();
  const deviceName = (req.query.deviceName as string)?.trim();
  if (!secret) {
    res.redirect("/?error=missing");
    return;
  }
  const deviceLabel = (req.query.deviceLabel as string)?.trim() || undefined;
  const device = deviceId && deviceName ? { id: deviceId, name: deviceName } : undefined;
  const auth = await jf.authenticateWithQuickConnect(secret, device);
  if (!auth) {
    res.redirect("/?error=auth");
    return;
  }
  const username = (await jf.getCurrentUserName(auth.accessToken)) ?? auth.userId;

  if (intent === "link") {
    // Create one linked device with this token and show app password.
    const appPassword = addLinkedDevice(username, auth.userId, auth.accessToken, deviceLabel);
    setJellyfinSession(username, auth.userId, auth.accessToken);
    setSessionUser(res, username);
    res.send(renderDeviceLinkedPage(username, appPassword, deviceLabel));
    return;
  }

  // Manage devices: remember session and go to device management.
  setJellyfinSession(username, auth.userId, auth.accessToken);
  setSessionUser(res, username);
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

router.post("/web/link/new-device", async (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/link");
    return;
  }
  const deviceLabel = (req.body?.deviceLabel as string | undefined)?.trim() || undefined;

  const creds = getJellyfinCredentialsForLinking(sessionUser);
  if (!creds) {
    res.redirect("/?error=no-device");
    return;
  }
  const newAuth = await jf.getNewTokenViaQuickConnect(
    creds.jellyfinAccessToken,
    creds.jellyfinUserId
  );
  if (!newAuth) {
    res.redirect("/devices?error=qc-failed");
    return;
  }

  const appPassword = addLinkedDevice(
    sessionUser,
    newAuth.userId,
    newAuth.accessToken,
    deviceLabel
  );
  res.send(renderDeviceLinkedPage(sessionUser, appPassword, deviceLabel));
});

router.get("/devices", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/");
    return;
  }
  const err = (req.query.error as string) || "";
  const ok =
    (req.query.unlinked as string) === "1" ||
    (req.query.renamed as string) === "1" ||
    (req.query.unshared as string) === "1";
  const devices = listLinkedDevices(sessionUser);
  const shares = getSharesForUser(sessionUser);
  const flash =
    err === "qc-failed"
      ? '<p class="card card-muted" style="margin-bottom: 14px; border-left: 4px solid #b91c1c;">Quick Connect failed or was denied. No device was created. Try again (approve in Jellyfin: Settings → Quick Connect).</p>'
      : err === "unshare"
            ? '<p class="card card-muted" style="margin-bottom: 14px; border-left: 4px solid #b91c1c;">Could not unshare (share not found or already removed).</p>'
            : ok
              ? '<p class="card card-muted" style="margin-bottom: 14px;">Done.</p>'
              : "";
  res.send(
    renderLayout(
      "My devices - Subfin",
      `
          ${renderDashboardHeader(sessionUser)}
          <main class="shell-main">
            ${flash}
            <div class="shell-main-full">
              ${renderAuthenticatedDashboard(sessionUser, devices, shares)}
            </div>
          </main>
        `
    )
  );
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
          ${renderAuthenticatedDashboard(username, devices, getSharesForUser(username))}
        </main>
      `
    )
  );
});

router.post("/web/devices/unlink", async (req: Request, res: Response) => {
  const resolved = getUsernameForDeviceAction(req);
  if ("errorRedirect" in resolved) {
    res.redirect(resolved.errorRedirect);
    return;
  }
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  if (Number.isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }
  const token = getDeviceJellyfinToken(deviceId, resolved.username);
  if (token) {
    await jf.reportSessionEnded(token);
  }
  const ok = unlinkDevice(deviceId, resolved.username);
  res.redirect(ok ? "/devices?unlinked=1" : "/devices?error=unlink");
});

router.post("/web/devices/reset", (req: Request, res: Response) => {
  const resolved = getUsernameForDeviceAction(req);
  if ("errorRedirect" in resolved) {
    res.redirect(resolved.errorRedirect);
    return;
  }
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  if (Number.isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }
  const newPassword = resetAppPassword(deviceId, resolved.username);
  if (!newPassword) {
    res.redirect("/devices?error=reset");
    return;
  }
  res.send(`
${renderLayout(
  "New password - Subfin",
  `
    ${renderDashboardHeader(resolved.username)}
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

router.post("/web/shares/delete", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/");
    return;
  }
  const shareUid = (req.body?.share_uid as string)?.trim();
  if (!shareUid) {
    res.redirect("/devices?error=missing");
    return;
  }
  const deleted = deleteShare(shareUid, sessionUser);
  res.redirect(deleted ? "/devices?unshared=1" : "/devices?error=unshare");
});

router.post("/web/shares/update", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/");
    return;
  }
  const shareUid = (req.body?.share_uid as string)?.trim();
  const description = (req.body?.description as string)?.trim() || null;
  if (!shareUid) {
    res.redirect("/devices?error=missing");
    return;
  }
  const updated = updateShare(shareUid, sessionUser, { description });
  res.redirect(updated ? "/devices?renamed=1" : "/devices?error=rename");
});

router.post("/web/devices/rename", (req: Request, res: Response) => {
  const resolved = getUsernameForDeviceAction(req);
  if ("errorRedirect" in resolved) {
    res.redirect(resolved.errorRedirect);
    return;
  }
  const deviceId = parseInt(req.body?.deviceId as string, 10);
  const rawLabel = (req.body?.deviceLabel as string | undefined) ?? "";
  const deviceLabel = rawLabel.trim() === "" ? null : rawLabel.trim();

  if (Number.isNaN(deviceId)) {
    res.redirect("/devices?error=missing");
    return;
  }

  const ok = renameDevice(deviceId, resolved.username, deviceLabel);
  res.redirect(ok ? "/devices?renamed=1" : "/devices?error=rename");
});

router.post("/web/logout", (req: Request, res: Response) => {
  clearSessionUser(res);
  res.redirect("/");
});

// --- Create share (session-authenticated JSON API) ---

router.post("/web/api/create-share", async (req: Request, res: Response) => {
  const auth = getAuthFromSession(req);
  if (!auth) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  const body = (req.body as Record<string, unknown>) ?? {};
  const urlInput = typeof body.url === "string" ? body.url : undefined;
  const idsInput = Array.isArray(body.ids) ? body.ids : undefined;
  const description = typeof body.description === "string" ? body.description.trim() || undefined : undefined;

  let ids: string[] = [];
  if (urlInput) {
    const id = parseJellyfinItemIdFromUrl(urlInput);
    if (!id) {
      res.status(400).json({ error: "Could not parse item id from URL. Use a Jellyfin details URL (e.g. #/details?id=...)." });
      return;
    }
    ids = [id];
  } else if (idsInput?.length) {
    ids = idsInput.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  }
  if (ids.length === 0) {
    res.status(400).json({ error: "Provide either url or ids." });
    return;
  }

  try {
    const payload = await handleCreateShare(auth, { ids, description });
    const share = (payload.shares as { share?: { url?: string }[] })?.share?.[0];
    const shareUrl = share?.url;
    if (!shareUrl) {
      res.status(500).json({ error: "Share was created but no URL returned." });
      return;
    }
    res.json({ url: shareUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Create share failed.";
    res.status(400).json({ error: message });
  }
});

router.get("/web/api/search", async (req: Request, res: Response) => {
  const auth = getAuthFromSession(req);
  if (!auth) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  const query = (req.query.query as string)?.trim() ?? "";
  const ctx = toJellyfinContext(auth);
  const [searchPayload, playlistsRaw] = await Promise.all([
    query ? handleSearch3(auth, { query, artistCount: "15", albumCount: "15", songCount: "30" }) : Promise.resolve({ searchResult3: { artist: [], album: [], song: [] } }),
    jf.getPlaylists(ctx, auth.jellyfinUserId),
  ]);
  const playlists = query
    ? playlistsRaw.filter((p) => (p.name ?? "").toLowerCase().includes(query.toLowerCase())).map((p) => ({ id: p.id, name: p.name ?? "" }))
    : [];
  res.json({ searchResult3: (searchPayload as { searchResult3: unknown }).searchResult3, playlists });
});

// ----- Create share page (authenticated) -----

router.get("/create-share", (req: Request, res: Response) => {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.redirect("/");
    return;
  }
  res.send(
    renderLayout(
      "Create share - Subfin",
      `
        ${renderDashboardHeader(sessionUser, { backToDevices: true })}
        <main class="shell-main">
          <div class="shell-main-full">
            <section class="hero">
              <div class="hero-title">Create a share link</div>
              <p class="hero-subtitle">
                Paste a Jellyfin URL or search your library, then copy the Subfin share link to send to anyone.
              </p>
            </section>
            <div class="dashboard-grid">
              <div class="card">
                <div class="card-header">
                  <div class="card-title">From Jellyfin URL</div>
                </div>
                <div class="card-body">
                  <p class="tiny" style="margin-bottom:8px;">Paste a link to a playlist, album, or track from your Jellyfin web UI (e.g. <code>…/details?id=…</code>).</p>
                  <form id="share-from-url-form" class="stack" style="gap:10px;">
                    <input type="url" name="url" id="share-url-input" class="create-share-url-input" placeholder="https://jellyfin.example.com/web/#/details?id=...">
                    <div class="actions-row">
                      <button type="submit">Create share link</button>
                      <span id="share-url-status" class="tiny"></span>
                    </div>
                    <div id="share-url-result" class="tiny" style="display:none; margin-top:8px;">
                      <label>Share link (copy and send):</label>
                      <div class="actions-row" style="margin-top:4px;">
                        <input type="text" id="share-url-output" readonly style="flex:1 1 auto; min-width:0;">
                        <button type="button" id="share-url-copy">Copy</button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>
              <div class="card">
                <div class="card-header">
                  <div class="card-title">Search and share</div>
                </div>
                <div class="card-body">
                  <p class="tiny" style="margin-bottom:8px;">Search for an artist, album, song, or playlist and add items. Then create one share link for the selection.</p>
                  <div class="stack" style="gap:10px;">
                    <div class="create-share-search-row">
                      <input type="text" id="search-query" placeholder="Search...">
                      <button type="button" id="search-btn">Search</button>
                    </div>
                    <div id="search-results" style="display:none;">
                      <div class="tiny" style="margin-bottom:6px;">Select one or more (same type or mix):</div>
                      <div id="search-results-list" class="search-results-list"></div>
                      <button type="button" id="search-create-share" style="margin-top:10px;">Create share link from selection</button>
                    </div>
                    <div id="search-share-result" class="tiny" style="display:none; margin-top:8px;">
                      <label>Share link:</label>
                      <div class="actions-row" style="margin-top:4px;">
                        <input type="text" id="search-share-output" readonly style="flex:1 1 auto; min-width:0;">
                        <button type="button" id="search-share-copy">Copy</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
        <script>
(function() {
  var base = window.location.origin;
  function copyText(el) {
    var t = el.value || el.textContent;
    if (!t) return;
    navigator.clipboard.writeText(t).then(function() {
      var btn = document.getElementById('share-url-copy') || document.getElementById('search-share-copy');
      if (btn) { btn.textContent = 'Copied'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
    });
  }
  // --- URL paste ---
  document.getElementById('share-from-url-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var input = document.getElementById('share-url-input');
    var status = document.getElementById('share-url-status');
    var resultDiv = document.getElementById('share-url-result');
    var output = document.getElementById('share-url-output');
    status.textContent = 'Creating…';
    resultDiv.style.display = 'none';
    fetch(base + '/web/api/create-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ url: (input && input.value) ? input.value.trim() : '' })
    }).then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
      .then(function(o) {
        if (o.ok && o.data.url) {
          status.textContent = '';
          if (output) output.value = o.data.url;
          resultDiv.style.display = 'block';
        } else {
          status.textContent = o.data.error || 'Failed';
        }
      }).catch(function() { status.textContent = 'Request failed'; });
  });
  document.getElementById('share-url-copy').addEventListener('click', function() {
    copyText(document.getElementById('share-url-output'));
  });
  // --- Search ---
  var selectedIds = [];
  function renderResults(data) {
    var list = document.getElementById('search-results-list');
    if (!list) return;
    list.innerHTML = '';
    selectedIds = [];
    var sr = data.searchResult3 || {};
    var playlists = data.playlists || [];
    function addSection(title, items, idKey, prefix) {
      if (!items || items.length === 0) return;
      var h = document.createElement('div');
      h.className = 'search-result-section';
      h.textContent = title;
      list.appendChild(h);
      items.forEach(function(item) {
        var id = item[idKey] || item.id;
        if (!id) return;
        var row = document.createElement('label');
        row.className = 'search-result-row';
        var name = item.name || item.title || item.album || '';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.id = prefix ? prefix + id : id;
        cb.dataset.name = name;
        cb.addEventListener('change', function() {
          if (cb.checked) selectedIds.push(cb.dataset.id);
          else selectedIds = selectedIds.filter(function(x) { return x !== cb.dataset.id; });
        });
        row.appendChild(cb);
        row.appendChild(document.createTextNode(name));
        list.appendChild(row);
      });
    }
    addSection('Artists', sr.artist, 'id', 'ar-');
    addSection('Albums', sr.album, 'id', 'al-');
    addSection('Songs', sr.song, 'id', '');
    addSection('Playlists', playlists, 'id', 'pl-');
    document.getElementById('search-results').style.display = 'block';
  }
  document.getElementById('search-btn').addEventListener('click', function() {
    var q = document.getElementById('search-query');
    var query = (q && q.value) ? q.value.trim() : '';
    if (!query) return;
    fetch(base + '/web/api/search?query=' + encodeURIComponent(query), { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(renderResults)
      .catch(function() { document.getElementById('search-results-list').innerHTML = '<span class="tiny">Search failed</span>'; });
  });
  document.getElementById('search-create-share').addEventListener('click', function() {
    if (selectedIds.length === 0) {
      alert('Select at least one item.');
      return;
    }
    fetch(base + '/web/api/create-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ids: selectedIds })
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(o) {
        var resultDiv = document.getElementById('search-share-result');
        var output = document.getElementById('search-share-output');
        if (o.ok && o.data.url && output) {
          output.value = o.data.url;
          resultDiv.style.display = 'block';
        } else {
          alert(o.data.error || 'Failed to create share');
        }
      }).catch(function() { alert('Request failed'); });
  });
  document.getElementById('search-share-copy').addEventListener('click', function() {
    copyText(document.getElementById('search-share-output'));
  });
})();
        </script>
      `
    )
  );
});

// ----- Share page (public link with optional secret) -----

/** GET /share/:share_uid?secret=xxx — validate (share_uid, secret), set share cookie, redirect to /share/:share_uid (no secret in URL). */
router.get("/share/:share_uid", shareEndpointRateLimit, async (req: Request, res: Response) => {
  const raw = req.params.share_uid;
  const shareUid = (typeof raw === "string" ? raw : raw?.[0] ?? "").trim();
  if (!shareUid) {
    res.status(400).send("Missing share id");
    return;
  }
  const secret = (req.query.secret as string)?.trim();

  if (secret) {
    const resolved = resolveShareAuth(shareUid, secret);
    if (!resolved) {
      if (!recordShareAuthFailure(req)) {
        res.status(429).setHeader("Retry-After", "60").send("Too many attempts");
        return;
      }
      res.status(403).send("Invalid or expired link");
      return;
    }
    setShareCookie(res, shareUid);
    res.redirect(`/share/${shareUid}`);
    return;
  }

  // No secret: require valid share cookie
  const session = getShareSessionFromCookie(req);
  if (!session || session.shareUid !== shareUid) {
    res.status(200).send(renderShareNeedsSecret(shareUid));
    return;
  }

  const share = getShareByUid(shareUid);
  if (!share) {
    clearShareCookie(res);
    res.status(404).send("Share not found");
    return;
  }
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    clearShareCookie(res);
    res.status(403).send("This share has expired");
    return;
  }

  const auth = getShareAuthByUid(shareUid);
  if (!auth) {
    res.status(500).send("Share unavailable");
    return;
  }
  incrementShareVisitCount(shareUid);

  const ctx = toJellyfinContext({
    subsonicUsername: auth.subsonicUsername,
    jellyfinUserId: auth.jellyfinUserId,
    jellyfinAccessToken: auth.jellyfinAccessToken,
  });
  let flatIds: string[] = [];
  try {
    flatIds = JSON.parse(share.entry_ids_flat) as string[];
    if (!Array.isArray(flatIds)) flatIds = [];
  } catch {
    flatIds = [];
  }
  const entries: { id: string; title: string; artist: string; album: string; duration: number }[] = [];
  for (const id of flatIds) {
    const song = await jf.getSong(ctx, id);
    if (song) {
      const duration = song.RunTimeTicks ? Math.round(Number(song.RunTimeTicks) / 10000) : 0;
      entries.push({
        id,
        title: song.Name ?? "Unknown",
        artist: (song as Record<string, string | undefined>).AlbumArtist ?? song.Artists?.[0] ?? "",
        album: (song as Record<string, string | undefined>).Album ?? "",
        duration,
      });
    }
  }

  const baseUrl = (config.subfinPublicUrl || "").replace(/\/$/, "") || `http://localhost:${config.port}`;
  res.send(renderSharePlayerPage({ shareUid, description: share.description ?? "", entries, baseUrl }));
});

/** GET /share/:share_uid/m3u — return M3U playlist (cookie auth). URLs are absolute with short-lived token. */
router.get("/share/:share_uid/m3u", shareEndpointRateLimit, async (req: Request, res: Response) => {
  const raw = req.params.share_uid;
  const shareUid = (typeof raw === "string" ? raw : raw?.[0] ?? "").trim();
  const session = getShareSessionFromCookie(req);
  if (!session || session.shareUid !== shareUid) {
    res.status(401).send("Unauthorized");
    return;
  }
  const share = getShareByUid(shareUid);
  if (!share) {
    res.status(404).send("Not found");
    return;
  }
  let flatIds: string[] = [];
  try {
    flatIds = JSON.parse(share.entry_ids_flat) as string[];
    if (!Array.isArray(flatIds)) flatIds = [];
  } catch {
    flatIds = [];
  }
  const baseUrl = (config.subfinPublicUrl || "").replace(/\/$/, "") || `http://localhost:${config.port}`;
  const token = createShareToken(shareUid);
  const auth = getShareAuthByUid(shareUid);
  const ctx = auth ? toJellyfinContext({ subsonicUsername: auth.subsonicUsername, jellyfinUserId: auth.jellyfinUserId, jellyfinAccessToken: auth.jellyfinAccessToken }) : null;
  const lines = ["#EXTM3U"];
  for (const id of flatIds) {
    if (ctx) {
      const song = await jf.getSong(ctx, id);
      const duration = song?.RunTimeTicks ? Math.round(Number(song.RunTimeTicks) / 10000000) : 0;
      const artist = (song as Record<string, string | undefined>)?.AlbumArtist ?? song?.Artists?.[0] ?? "Unknown";
      const title = song?.Name ?? "Track";
      lines.push(`#EXTINF:${duration},${artist} - ${title}`);
    }
    lines.push(`${baseUrl}/rest/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  }
  res.setHeader("Content-Type", "audio/mpegurl");
  res.setHeader("Content-Disposition", `attachment; filename="share-${shareUid.slice(0, 8)}.m3u"`);
  res.send(lines.join("\n"));
});

/** GET /share/:share_uid/zip — stream all share tracks as a zip with playlist.m3u (cookie auth). */
router.get("/share/:share_uid/zip", shareEndpointRateLimit, async (req: Request, res: Response) => {
  const raw = req.params.share_uid;
  const shareUid = (typeof raw === "string" ? raw : raw?.[0] ?? "").trim();
  const session = getShareSessionFromCookie(req);
  if (!session || session.shareUid !== shareUid) {
    res.status(401).send("Unauthorized");
    return;
  }
  const share = getShareByUid(shareUid);
  if (!share) {
    res.status(404).send("Not found");
    return;
  }
  const auth = getShareAuthByUid(shareUid);
  if (!auth) {
    res.status(500).send("Share unavailable");
    return;
  }
  let flatIds: string[] = [];
  try {
    flatIds = JSON.parse(share.entry_ids_flat) as string[];
    if (!Array.isArray(flatIds)) flatIds = [];
  } catch {
    flatIds = [];
  }
  if (flatIds.length === 0) {
    res.status(400).send("Share has no tracks");
    return;
  }

  const ctx = toJellyfinContext({
    subsonicUsername: auth.subsonicUsername,
    jellyfinUserId: auth.jellyfinUserId,
    jellyfinAccessToken: auth.jellyfinAccessToken,
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="share-${shareUid.slice(0, 8)}.zip"`);

  const archive = (archiver as (format: string, opts?: { zlib?: { level?: number } }) => {
    pipe: (dest: NodeJS.WritableStream) => void;
    append: (src: NodeJS.ReadableStream | Buffer | string, opts: { name: string }) => void;
    finalize: () => Promise<void>;
  })("zip", { zlib: { level: 0 } });
  archive.pipe(res);

  const m3uLines: string[] = ["#EXTM3U"];
  for (let i = 0; i < flatIds.length; i++) {
    const id = flatIds[i]!;
    const song = await jf.getSong(ctx, id);
    const artist = song ? ((song as Record<string, string | undefined>).AlbumArtist ?? song.Artists?.[0] ?? "Unknown") : "Unknown";
    const title = song?.Name ?? "Track";
    const safeName = `${String(i + 1).padStart(3, "0")} - ${sanitizeZipFileName(artist)} - ${sanitizeZipFileName(title)}.mp3`;
    m3uLines.push(`#EXTINF:${Math.round((song?.RunTimeTicks ?? 0) / 10000000)},${artist} - ${title}`);
    m3uLines.push(safeName);
    const url = jf.getDownloadUrl(ctx, auth.jellyfinUserId, id);
    try {
      const resp = await axios.get(url, { responseType: "stream", maxRedirects: 3 });
      await new Promise<void>((resolve, reject) => {
        const stream = resp.data as NodeJS.ReadableStream;
        stream.on("error", reject);
        archive.append(stream, { name: safeName });
        stream.on("end", resolve);
      });
    } catch (err) {
      console.error("Share zip: stream failed for", id, err);
      archive.append(Buffer.from(""), { name: safeName });
    }
  }
  archive.append(m3uLines.join("\n"), { name: "playlist.m3u" });
  await archive.finalize();
});

function renderShareNeedsSecret(shareUid: string): string {
  const action = `/share/${shareUid}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Share link</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui; max-width:420px; margin:2rem auto; padding:1rem;">
  <h1 style="font-size:1.25rem;">This link is private</h1>
  <p>Enter the secret from the share link to continue.</p>
  <form method="get" action="${escapeHtml(action)}">
    <p><label>Secret: <input type="password" name="secret" autocomplete="off" required style="padding:6px 10px;"></label></p>
    <p><button type="submit">Continue</button></p>
  </form>
</body></html>`;
}

function renderSharePlayerPage(opts: {
  shareUid: string;
  description: string;
  entries: { id: string; title: string; artist: string; album: string; duration: number }[];
  baseUrl: string;
}): string {
  const { shareUid, description, entries, baseUrl } = opts;
  const listItems = entries
    .map(
      (e, i) =>
        `<li class="share-track" data-id="${escapeHtml(e.id)}" data-index="${i}">
          <span class="share-track-info">
            <span class="share-track-title">${escapeHtml(e.title)}</span>
            <span class="share-track-meta">${escapeHtml(e.artist)}${e.album ? " · " + escapeHtml(e.album) : ""}</span>
          </span>
          <a class="share-track-dl" href="${escapeHtml(baseUrl)}/rest/download?id=${encodeURIComponent(e.id)}" download title="Download track">\u2193</a>
        </li>`
    )
    .join("");
  const tracksJson = JSON.stringify(entries.map((e) => ({ id: e.id, title: e.title, duration: e.duration })));
  const baseUrlEsc = escapeHtml(baseUrl);
  const shareUidEsc = escapeHtml(shareUid);
  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><title>${description ? escapeHtml(description) : "Shared music"} – Subfin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *{box-sizing:border-box;}
    html,body{margin:0;height:100%;font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;}
    body{padding:1rem;display:flex;justify-content:center;}
    .share-wrap{width:100%;max-width:420px;display:flex;flex-direction:column;min-height:0;flex:1;}
    .share-actions{margin-bottom:1rem;flex-shrink:0;}
    .share-actions a{color:#38bdf8;margin-right:1rem;font-size:0.9rem;}
    .share-header{margin-bottom:1rem;flex-shrink:0;}
    .share-desc{color:#94a3b8;font-size:0.9rem;}
    .share-art-wrap{width:100%;aspect-ratio:1;max-width:320px;margin:0 auto 0.5rem;flex-shrink:0;position:relative;background:rgba(30,41,59,0.9);border-radius:12px;overflow:hidden;}
    .share-art-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:5rem;opacity:0.5;}
    .share-art{width:100%;height:100%;object-fit:cover;display:block;}
    .share-art.reveal{position:relative;}
    .share-controls{flex-shrink:0;margin:0.5rem 0;}
    .share-controls audio{width:100%;height:36px;display:block;}
    .share-list{list-style:none;padding:0;margin:0;flex:1;min-height:180px;overflow-y:auto;-webkit-overflow-scrolling:touch;}
    .share-track{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;cursor:pointer;margin-bottom:6px;background:rgba(30,41,59,0.8);border:1px solid rgba(71,85,105,0.5);}
    .share-track:hover,.share-track.playing{background:rgba(56,189,248,0.15);border-color:rgba(56,189,248,0.4);}
    .share-track-info{flex:1;min-width:0;}
    .share-track-title{font-weight:500;display:block;}
    .share-track-meta{font-size:0.8rem;color:#94a3b8;}
    .share-track-dl{color:#94a3b8;text-decoration:none;padding:4px 8px;flex-shrink:0;}
    .share-track-dl:hover{color:#38bdf8;}
  </style>
</head>
<body>
  <div class="share-wrap">
    <div class="share-actions">
      <a href="${baseUrlEsc}/share/${shareUidEsc}/m3u">Download M3U</a>
      <a href="${baseUrlEsc}/share/${shareUidEsc}/zip">Download as ZIP</a>
    </div>
    <div class="share-header">
      <h1 style="font-size:1.25rem;">${description ? escapeHtml(description) : "Shared music"}</h1>
      <p class="share-desc">${entries.length} track${entries.length !== 1 ? "s" : ""}</p>
    </div>
    <div class="share-art-wrap">
      <div class="share-art-placeholder" id="artPlaceholder">&#127911;</div>
      <img id="coverArt" class="share-art" src="" alt="" style="display:none;">
    </div>
    <div class="share-controls">
      <audio id="audio" controls></audio>
    </div>
    <ul class="share-list" id="list">${listItems}</ul>
  </div>
  <script>
    (function(){
      var baseUrl = ${JSON.stringify(baseUrl)};
      var tracks = ${tracksJson};
      var audio = document.getElementById('audio');
      var list = document.getElementById('list');
      var coverArt = document.getElementById('coverArt');
      var artPlaceholder = document.getElementById('artPlaceholder');
      var currentIndex = -1;

      function setTrack(idx){
        if (idx < 0 || idx >= tracks.length) return;
        currentIndex = idx;
        var t = tracks[idx];
        audio.src = baseUrl + '/rest/stream?id=' + encodeURIComponent(t.id);
        coverArt.src = baseUrl + '/rest/getCoverArt?id=' + encodeURIComponent(t.id) + '&size=320';
        coverArt.style.display = 'block';
        coverArt.alt = t.title;
        artPlaceholder.style.display = 'none';
        list.querySelectorAll('.share-track').forEach(function(el){ el.classList.remove('playing'); });
        var li = list.querySelector('.share-track[data-index="' + idx + '"]');
        if (li) { li.classList.add('playing'); li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      }

      audio.addEventListener('play', function(){
        if (currentIndex < 0 && tracks.length > 0) { setTrack(0); audio.play(); }
      });
      audio.addEventListener('ended', function(){
        if (currentIndex >= 0 && currentIndex < tracks.length - 1) {
          setTrack(currentIndex + 1);
          audio.play();
        }
      });

      list.addEventListener('click', function(e){
        if (e.target.closest('.share-track-dl')) return;
        var li = e.target.closest('.share-track');
        if (!li) return;
        var idx = parseInt(li.dataset.index, 10);
        setTrack(idx);
        audio.play();
      });
    })();
  </script>
</body></html>`;
}

/** Safe filename for zip entries (no path separators or invalid chars). */
function sanitizeZipFileName(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "track";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve authenticated username for device actions (unlink, reset, rename).
 * With session: use session user. Without: require username + password in body and validate with app password.
 * Returns username or an error redirect path.
 */
function getUsernameForDeviceAction(req: Request): { username: string } | { errorRedirect: string } {
  const sessionUser = getSessionUser(req);
  if (sessionUser) return { username: sessionUser };

  const username = (req.body?.username as string)?.trim();
  const password = req.body?.password as string;
  if (!username || !password) return { errorRedirect: "/devices?error=missing" };
  const token = resolveToJellyfinToken(username, password);
  if (!token) return { errorRedirect: "/devices?error=wrong" };
  return { username };
}

export { router as webRouter };
