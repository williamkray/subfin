# Security Audit Report

**Project:** Subfin  
**Date:** 2026-03-06  
**Scope:** Full codebase security review (including Web UI, SQLite store, and Subsonic REST)

## Executive summary

The review identified **1 High** (legacy only), **3 Medium**, and several **Low**/**Info** findings. The **active store is SQLite** with bcrypt-hashed app passwords and AES-256-GCM–encrypted Jellyfin tokens; the **High** finding applies only to **legacy** `subfin.json` (or backups) if they still exist. **Web device unlink/reset/rename** correctly require either a session cookie or username+app-password and the store enforces per-username device ownership (no IDOR). Remaining risks: **no rate limiting** on auth or device flows, **QuickConnect secrets in URLs** with no TTL, and **debug logging** that can leak tokens when `SUBFIN_LOG_REST` is on. **npm audit** reports 0 vulnerabilities. Recommended actions: remove or restrict legacy JSON store files; add rate limiting; expire pending QuickConnect entries; redact tokens in logs; set Secure cookie and security headers when deployed over HTTPS.

## Summary table

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| 1 | High | Plaintext app passwords and Jellyfin tokens in legacy JSON store | src/store/index.ts |
| 2 | Medium | Debug logging can leak Jellyfin tokens in URLs | src/subsonic/router.ts |
| 3 | Medium | No rate limiting on auth or device link/unlink/reset | src/index.ts, src/web/router.ts |
| 4 | Medium | Pending QuickConnect secrets in URL and no expiry | src/store/index.ts, src/web/router.ts |
| 5 | Low | Session cookie missing Secure flag | src/web/router.ts |
| 6 | Low | No security headers (CSP, X-Frame-Options, etc.) | src/index.ts |
| 7 | Low | Subsonic token auth uses MD5 | src/subsonic/auth.ts |
| 8 | Info | Vulnerable tar dependency (indirect, mitigated via overrides) | package.json, npm audit |
| 9 | Info | SUBFIN_LOG_REST documents token-in-URL risk | README / config |

## Findings

### 1 Plaintext app passwords and Jellyfin tokens in legacy JSON store (High — legacy only)

- **Location:** `src/store/index.ts` (legacy JSON migration); historical `subfin.json` or `subfin.json.migrated` if present.
- **Current state:** The **active store is SQLite** (`config.dbPath`, default `subfin.db`). Sensitive columns use **bcrypt** (app passwords) and **AES-256-GCM** (app password plaintext for token auth, Jellyfin tokens) with a key derived from `SUBFIN_SALT`. Legacy `subfin.json` is migrated once into SQLite and renamed to `subfin.json.migrated`; the code does not write new plaintext to JSON.
- **Description:** Any **pre-migration** or **backup** copy of `subfin.json` (or the renamed `.migrated` file) may still hold plaintext app passwords and Jellyfin tokens from before migration.
- **Impact:** Read access to such legacy files allows impersonation. The live SQLite store is not affected.
- **Recommendation:** Remove or tightly restrict (`chmod 600`, service user only) legacy `subfin.json` and `subfin.json.migrated`; do not back them up in plaintext. Document that new installs use SQLite only.
- **References:** OWASP Storage of Sensitive Data; CWE-312 (Cleartext Storage).

### 2 Debug logging can leak Jellyfin tokens in URLs (Medium)

- **Location:** `src/subsonic/router.ts` — when `config.logRest` is true: `console.log(\`[STREAM] url=${url}\`)`, `[DOWNLOAD] url=...`, `[COVER] ... url=...`
- **Description:** Stream, download, and cover-art URLs are built with `ApiKey` (Jellyfin access token) in the query string. When `SUBFIN_LOG_REST=true`, these URLs are logged to stdout.
- **Impact:** Log aggregation or console access can capture tokens; tokens could be reused to access the user’s Jellyfin account.
- **Recommendation:** When logging for debugging, redact the token (e.g. strip or replace `ApiKey` query param) or log only path/method, not full URL. Prefer keeping `SUBFIN_LOG_REST` off in production.
- **References:** CWE-532 (Insertion of Sensitive Information into Log).

### 3 No rate limiting on auth or device link/unlink/reset (Medium)

- **Location:** `src/index.ts` (no rate-limit middleware), `src/web/router.ts` (link, devices, unlink, reset), Subsonic REST auth in `src/subsonic/router.ts`
- **Description:** Login (Jellyfin auth), Subsonic auth (u/p or token), device link, unlink, and reset have no rate limiting.
- **Impact:** Brute-force attacks on passwords or app passwords; abuse of link/unlink/reset (e.g. combined with finding 2).
- **Recommendation:** Add rate limiting (e.g. express-rate-limit) for `/web/link`, `/web/devices`, `/web/devices/unlink`, `/web/devices/reset`, and for `/rest/*` when auth fails (e.g. per-IP and optionally per-username after N failures).
- **References:** OWASP Brute Force; CWE-307.

### 4 Pending QuickConnect secrets in URL and no expiry (Medium)

- **Location:** `src/store/index.ts` (`pending_quickconnect`), `src/web/router.ts` — `/web/quickconnect/poll?secret=...`, `/web/quickconnect/done?secret=...`
- **Description:** QuickConnect secret is passed in query parameters and stored in `pending_quickconnect` until consumed; there is no TTL or cleanup.
- **Impact:** Secret can appear in browser history, referrers, proxy logs. If an attacker obtains the secret, they can complete the flow and link the victim’s Jellyfin session to a device they control. Stale entries increase the window of exposure.
- **Recommendation:** (1) Prefer POST with secret in body for poll/done, or at least document that secrets appear in URLs and should not be logged. (2) Expire pending QuickConnect entries after a short TTL (e.g. 5–10 minutes) and prune on startup or periodically.
- **References:** CWE-598 (Information Exposure in Query String).

### 5 Session cookie missing Secure flag (Low)

- **Location:** `src/web/router.ts` — `setSessionUser()` sets `Set-Cookie` with `Path=/; HttpOnly; SameSite=Lax` but no `Secure`.
- **Description:** In production over HTTPS, the cookie can still be sent over HTTP if the app is ever reached via HTTP (redirect, misconfiguration).
- **Recommendation:** Set `Secure` when the app is served over HTTPS (e.g. when `req.protocol === 'https'` or when a config flag like `SUBFIN_HTTPS` is set).
- **References:** OWASP Session Management.

### 6 No security headers (Low)

- **Location:** `src/index.ts` — Express app has no helmet or equivalent; CORS is open via `app.use(cors())`.
- **Description:** No Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, etc.
- **Impact:** Defense-in-depth only; reduces risk of clickjacking, MIME sniffing, and some XSS if the app later serves more dynamic content.
- **Recommendation:** Add security headers (e.g. `helmet`) and restrict CORS origin if the Web UI is only used from a known origin.
- **References:** OWASP Secure Headers.

### 7 Subsonic token auth uses MD5 (Low)

- **Location:** `src/subsonic/auth.ts` — `computeToken()` uses `createHash("md5").update(password + salt, "utf8").digest("hex")`.
- **Description:** Subsonic protocol uses MD5 for token auth (t/s). MD5 is cryptographically weak.
- **Impact:** Protocol compatibility; an attacker with captured t/s traffic could attempt to brute-force the app password if they also obtain the salt. Risk is limited by the need to capture traffic and the fact that app passwords are random.
- **Recommendation:** Document as protocol limitation; keep app passwords high-entropy and consider deprecating token auth in favor of apiKey in clients that support it.
- **References:** CWE-328 (Use of Weak Hash).

### 8 Vulnerable tar dependency (Info, mitigated via overrides)

- **Location:** `package.json` overrides section and `npm audit`.
- **Changes since last review:** The project now explicitly overrides the vulnerable `tar` version via `"overrides": { "tar": "7.5.10" }`.
- **Description:** Previous reviews flagged transitive vulnerabilities in `tar`. The new override ensures a patched `tar` is used even if upstream dependencies lag behind.
- **Impact:** With the override in place and assuming `npm install` respects `overrides`, the specific known `tar` advisories should be mitigated. Residual risk is low and limited to any future advisories affecting `7.5.10`.
- **Recommendation:** Keep running `npm audit` periodically, and update the override version when new `tar` security releases appear. Verify that your deployment path (e.g. Docker image build) uses `npm` versions that honor `overrides`.
- **References:** npm advisories GHSA-* for node-tar.

### 9 SUBFIN_LOG_REST documents token-in-URL risk (Info)

- **Location:** Config and README; behavior in `src/subsonic/router.ts`.
- **Description:** Enabling `SUBFIN_LOG_REST` causes full URLs (with tokens) to be logged; this is a documentation / operational finding.
- **Recommendation:** In README or config comments, state that `SUBFIN_LOG_REST` must not be enabled in production or on shared logs because it can log Jellyfin tokens.
- **References:** See finding 3.

## Recommendations (prioritized)

1. **High:** Remove or protect plaintext app passwords and Jellyfin tokens in any legacy JSON stores and their backups; ensure new deployments use only the encrypted SQLite store.
2. **Medium:** Redact or avoid logging URLs that contain `ApiKey` when `SUBFIN_LOG_REST` is used; keep it off in production.
3. **Medium:** Add rate limiting for web link, devices, unlink, reset, and for Subsonic REST auth failures.
4. **Medium:** Expire pending QuickConnect entries by TTL; consider moving secret out of query string for poll/done.
5. **Low:** Set `Secure` on the session cookie when running over HTTPS.
6. **Low:** Add security headers (e.g. helmet) and tighten CORS if applicable.
7. **Info:** Document that SUBFIN_LOG_REST must not be used in production; keep dependency overrides (e.g. `tar`) up to date and rerun `npm audit` periodically.

## Appendix

- **Methodology:** Manual code review of auth, store, web and Subsonic routes, config, and dependencies; `npm audit` for known vulnerabilities.
- **Tools used:** grep/code search, npm audit (0 vulnerabilities as of 2026-03-06).
- **Positive notes:** Active store is SQLite with bcrypt and AES-256-GCM; Subsonic REST and Web device actions require auth; unlink/reset/rename enforce per-username device ownership (no IDOR); Web UI uses HttpOnly and SameSite=Lax; Docker runs as non-root; `.gitignore` covers `subfin.json`, `.env`, `.local-testing/`; XML/HTML output uses escaping for attributes and text.
