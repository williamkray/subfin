---
name: security-review
description: Performs a full security review and deep analysis of the codebase, documents and prioritizes vulnerabilities, and writes findings to SECURITY-AUDIT.md in the repository. Use when the user requests a security audit, vulnerability assessment, security review, or threat analysis.
---

# Security Review

## Purpose

Conduct a full security review of the codebase: identify vulnerabilities, prioritize them, and write a single **SECURITY-AUDIT.md** document in the repository root. The document is the canonical output and must be created or updated by the review.

## When to Use

- User asks for a "security review", "security audit", "vulnerability assessment", or "threat analysis"
- User asks to "document security issues" or "prioritize security vulnerabilities"
- User wants a subagent or dedicated run to "do a full security review"

## Output Location

**Always write (or overwrite) the findings to:**

- **Path:** `SECURITY-AUDIT.md` at the repository root (e.g. `/home/wreck/Code/subfin/SECURITY-AUDIT.md`)

## Prioritization Levels

Use these severity levels and sort findings by severity (Critical first, then High, Medium, Low, Info):

| Severity | Meaning | Examples |
|----------|---------|----------|
| **Critical** | Exploitable without special access; data breach or full compromise likely | Hardcoded secrets, auth bypass, SQL/command injection leading to RCE |
| **High** | Significant impact with moderate effort or preconditions | Plaintext storage of secrets, missing auth on sensitive endpoints, known-vuln dependencies |
| **Medium** | Meaningful risk; may require specific conditions | Weak hashing, missing rate limiting, verbose error leakage |
| **Low** | Best-practice or defense-in-depth improvements | Missing security headers, logging of sensitive data |
| **Info** | Informational or hardening suggestions | Dependency freshness, documentation gaps |

## Review Scope and Checklist

Cover at least:

1. **Authentication and authorization**
   - Token and password handling (storage, transmission, comparison)
   - Session/token lifetime and revocation
   - Auth bypass or privilege escalation paths
   - Subsonic auth params (u, p, t, s, apiKey) and mapping to Jellyfin

2. **Secrets and sensitive data**
   - Secrets in code, env, or config (and .gitignore for credentials)
   - Storage of credentials (e.g. JSON store: plain vs hashed, file permissions)
   - Logging or error messages that expose secrets or tokens

3. **Input validation and injection**
   - Query/ path/ body parameters used in URLs, file paths, or downstream APIs
   - IDOR (e.g. substituting another user’s IDs in API calls)
   - Prototype pollution or unsafe object handling if applicable

4. **HTTP and API security**
   - CORS, security headers (CSP, X-Frame-Options, etc.)
   - Rate limiting and brute-force protection on login/link
   - HTTPS enforcement and redirects

5. **Dependencies**
   - Known vulnerabilities (npm audit, or equivalent)
   - Unpinned or overly broad versions
   - Supply-chain and integrity (lockfile, optional integrity checks)

6. **Infrastructure and deployment**
   - File permissions for DB/store files
   - Running as root vs non-root in container
   - Exposure of internal URLs or debug endpoints

7. **Error handling and information disclosure**
   - Stack traces or internal details in responses
   - Different error content for "user exists" vs "wrong password" (timing/contents)

## Document Structure for SECURITY-AUDIT.md

Use this structure so the output is consistent and actionable:

```markdown
# Security Audit Report

**Project:** [e.g. Subfin]
**Date:** [YYYY-MM-DD]
**Scope:** [e.g. Full codebase security review]

## Executive summary

[2–4 sentences: overall risk level, number of Critical/High findings, and top recommendations.]

## Summary table

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| 1 | Critical | ... | path/to/file.ts |
| 2 | High | ... | ... |
...

## Findings

### [ID] [Title] (Severity)

- **Location:** file(s) and area (e.g. function, route)
- **Description:** What the issue is and how it manifests
- **Impact:** What an attacker could do
- **Recommendation:** Concrete fix or mitigation
- **References:** Optional CWE/OWASP or links

[Repeat for each finding.]

## Recommendations (prioritized)

1. [Critical/High action]
2. [Next action]
...

## Appendix

- **Methodology:** Manual code review + [e.g. npm audit]
- **Tools used:** [if any]
```

## Workflow

1. **Explore** the codebase (auth, store, web and API routes, config, dependencies).
2. **Identify** issues and assign severity using the table above.
3. **Deduplicate** and merge overlapping findings.
4. **Write** `SECURITY-AUDIT.md` at the repo root with the structure above; create the file if it does not exist.
5. **Do not** commit the file unless the user asks; only create/update it.

## Notes for This Repo (Subfin)

- Node/Express app; OpenSubsonic-to-Jellyfin proxy; auth in `src/subsonic/auth.ts`, store in `src/store/index.ts`, web UI and REST in `src/web/router.ts` and `src/subsonic/`.
- Pay special attention: app passwords and Jellyfin tokens in the JSON store, token auth (t/s), and any user-controlled input passed to Jellyfin or file system.
- Check `.gitignore` and any credential files (e.g. under `.local-testing/`) for accidental commit risk.
