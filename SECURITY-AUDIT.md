# Security Audit Report

**Project:** Subfin  
**Date:** 2026-03-05  
**Scope:** Full codebase security review (including recent Web UI and store changes)

## Executive summary

The review identified **1 High** and **3 Medium** severity issues, plus several **Low** and **Info** findings. The most serious is **plaintext storage of app passwords and Jellyfin tokens** in the JSON store (`subfin.json`), which allows anyone with read access to the file (e.g. host compromise, backup exposure) to impersonate users. **Web device unlink/reset does not verify the app password** when the request is made without a session cookie, allowing unlink or password reset with an arbitrary password for a known username and device ID. **No rate limiting** on login or link flows enables brute-force attempts. Recommended immediate actions: stop storing plaintext app passwords (or isolate/encrypt the store), verify credentials on unlink/reset when no session is present, and add rate limiting for auth and device-management endpoints.

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

### 1 Plaintext app passwords and Jellyfin tokens in legacy JSON store (High)

- **Location:** `src/store/index.ts` (legacy JSON migration); historical `subfin.json` store if still present.
- **Changes since last review:** The project now defaults to an **SQLite-backed store with encryption at rest** for sensitive columns; the code automatically migrates from a legacy JSON store (`subfin.json`) into SQLite on first run and renames the old file to `subfin.json.migrated`. App passwords in the active SQLite store are hashed with bcrypt and only the encrypted form is kept; Jellyfin tokens are encrypted in both the active store and the pending QuickConnect table.
- **Description:** If an old `subfin.json` file still exists and has not yet been migrated or securely removed, it may contain historical plaintext app passwords and Jellyfin tokens from older versions. The migration step now reads this file, encrypts and inserts data into SQLite, and then renames the JSON file to `subfin.json.migrated`, but any backups or extra copies of the JSON file remain sensitive.
- **Impact:** Anyone with read access to an old JSON store (on disk or in backups) can still recover app passwords and Jellyfin tokens and impersonate users. The active SQLite store is significantly better protected (hashed app passwords, encrypted tokens), but legacy artifacts retain prior risk until removed or secured.
- **Recommendation:** (1) After confirming migration to SQLite has completed, **remove or tightly restrict** any legacy `subfin.json` / `subfin.json.migrated` files (e.g. `chmod 600` and limit to the service user, or delete if no longer needed). (2) Highlight in deployment docs that these legacy JSON files are sensitive and should not be backed up in plaintext. (3) For new installs, ensure JSON-based storage is not used at all and that only the SQLite path is documented going forward.
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
- **Tools used:** grep/code search, npm audit.
- **Positive notes:** Passwords are verified with bcrypt for login; Subsonic REST requires auth for all sensitive methods; Web UI uses HttpOnly and SameSite=Lax; Docker runs as non-root; `.gitignore` covers `subfin.json`, `.env`, and `.local-testing/`; XML output uses escaping for attributes and text.
