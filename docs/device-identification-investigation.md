# Per-device identification in Jellyfin (investigation)

**Status: Implemented.** Per-device identity (device id/name from app-password/label) and client IP (X-Forwarded-For) are implemented. See `src/request-context.ts` (client IP), `src/subsonic/auth.ts` (`toJellyfinContext`, device fields on `AuthResult`), and `src/jellyfin/client.ts` (`JellyfinContext`, `getApi(ctx)`).

## Goal

Have each Subfin app-password (linked device) show up as a **separate device** in Jellyfin’s dashboard, with a recognizable name: the device **label** if set, otherwise e.g. **"Subfin Device &lt;id&gt;"**. Connection data sent to Jellyfin should also include the **client’s IP address** so it appears in the activity panel (e.g. “IP address: …”) as the user’s real address, including when Subfin runs behind a reverse proxy (using `X-Forwarded-For` / “true” client IP).

Today every request uses the same device identity from config (`JELLYFIN_DEVICE_ID` / `JELLYFIN_DEVICE_NAME`, e.g. "subfin-device-1" / "Subfin Middleware"), so all clients appear as one device in Jellyfin. Outbound requests to Jellyfin come from Subfin’s IP, so the activity panel shows Subfin’s address rather than the end user’s.

## How Jellyfin sees the device

- The [Jellyfin SDK](https://jellyfin.org/docs/general/server/devices/) and API send device identity in the auth/request layer (e.g. `X-Emby-Authorization` with `Device`, `DeviceId`).
- The SDK’s `deviceInfo: { id, name }` is set when creating the API instance; all requests made with that instance use that device.
- So we need a **different API instance (or different device id/name) per linked device** when making Jellyfin calls.

## How Jellyfin sees the client IP (activity panel)

- Jellyfin’s activity/overview shows **RemoteEndPoint** (e.g. “IP address: 2603:8001:…”) from the **incoming HTTP request** it receives. That is normally the TCP connection’s remote address.
- When the request comes from a **known proxy**, Jellyfin can use **X-Forwarded-For** (and related headers) to show the original client IP instead. The server must have the proxy’s IP in **Network → Known Proxies** or it will ignore forwarded headers (to avoid spoofing).
- So: when Subfin calls Jellyfin, the connection is from Subfin (or the proxy in front of Subfin). To have the **end user’s** IP appear in the activity panel, Subfin must send the user’s IP on outbound requests, e.g. by setting **X-Forwarded-For** to that address. Jellyfin will then use it only if Subfin’s own IP (or the reverse proxy’s) is configured as a known proxy.

## What we have today

| Layer | Current behavior |
|-------|------------------|
| **Store** | `linked_devices` has `id` (PK), `device_label` (nullable). When we resolve auth (username + app password), we match one row but only return `jellyfinUserId` and `jellyfinAccessToken` — we do **not** return which device (id, label). |
| **Auth** | `AuthResult` = `{ subsonicUsername, jellyfinUserId, jellyfinAccessToken }`. No device identity. |
| **Jellyfin client** | `createJellyfinApi(accessToken)` uses global config `jf.deviceId` and `jellyfin.deviceName` for all callers. API is cached by `accessToken` only. |
| **Handlers** | All pass `auth.jellyfinAccessToken` (and often `auth.jellyfinUserId`) into `jf.*`; no device info. |

So: we already know *which* linked device is making the request (the row we matched by password), but we never pass that device’s id/label into the Jellyfin layer.

## What would be required

### 1. Store

- **resolveToJellyfinToken(username, password)**  
  Return the matched **device** as well: e.g.  
  `{ jellyfinUserId, jellyfinAccessToken, deviceId: number, deviceLabel: string | null }`  
  (deviceId = `linked_devices.id`, deviceLabel = `linked_devices.device_label`).
- **getDevicesForToken(username)** (used for token auth)  
  Include in each returned device: `id` (numeric) and `device_label` so that when we match by token we know which device it is.
- **No schema change** — we already have `id` and `device_label` on `linked_devices`. We only need to expose them from resolution.

### 2. Auth

- **AuthResult**  
  Add optional:  
  `jellyfinDeviceId?: string`  
  `jellyfinDeviceName?: string`  
  with the convention:  
  - `jellyfinDeviceId` = `"subfin-" + linked_devices.id` (stable, unique per device).  
  - `jellyfinDeviceName` = `device_label ?? "Subfin Device " + linked_devices.id`.
- **resolveAuth** (and **resolveAuthFromBasicHeader**)  
  When we get a result from `resolveToJellyfinToken` or from the token-auth path with `getDevicesForToken`, set `jellyfinDeviceId` and `jellyfinDeviceName` on `AuthResult` from the matched device’s id and label.
- **Web router** (link flow)  
  Link flow uses `resolveToJellyfinToken`; if we only need device identity for **REST** requests, we can leave web unchanged. If we ever want device identity during link, we’d pass it through there too (optional follow-up).

### 3. Jellyfin client

- **createJellyfinApi**  
  - Signature: e.g. `createJellyfinApi(accessToken: string, device?: { id: string; name: string })`.  
  - When `device` is provided, use `device.id` and `device.name` for `deviceInfo`; otherwise keep current behavior (config’s `jf.deviceId` / `jellyfin.deviceName`).  
  - **Cache key** must include device id when present, e.g. `accessToken + (device?.id ?? 'default')`, so each logical device gets its own API instance (and thus its own identity in Jellyfin).
- **All call sites**  
  There are **~45** internal call sites of `createJellyfinApi(accessToken)` in `src/jellyfin/client.ts`. Each needs to pass the optional device when available.  
  **Preferred approach:** introduce a small **context** type used as the first argument for every public Jellyfin function, e.g.:  
  - `JellyfinContext = string | { accessToken: string; userId?: string; deviceId?: string; deviceName?: string }`  
  - Helper: `getApi(ctx)` normalizes `ctx` to `(token, device?)` and calls `createJellyfinApi(token, device)`.  
  - Every exported function that currently takes `(accessToken: string, ...)` becomes `(ctx: JellyfinContext, ...)` and uses `getApi(ctx)` instead of `createJellyfinApi(accessToken)`.  
  That way we only add one parameter and one line per function; no extra “last parameter” or overloads.

### 4. Handlers (Subsonic REST)

- Every handler that calls `jf.*` currently passes `auth.jellyfinAccessToken` (and sometimes `auth.jellyfinUserId`).  
- They need to pass a **context object** when device is available, e.g.:  
  `{ accessToken: auth.jellyfinAccessToken, userId: auth.jellyfinUserId, deviceId: auth.jellyfinDeviceId, deviceName: auth.jellyfinDeviceName }`  
  so the Jellyfin layer can call `createJellyfinApi(accessToken, device)` when `deviceId`/`deviceName` are set.
- **Rough scope:** on the order of **~50–80** call sites in `handlers.ts` (and any other files that call `jf.*`). Most are one-line changes: replace `auth.jellyfinAccessToken` (and similar) with the context object.

### 5. Client IP (activity panel / “true” IP behind reverse proxy)

To show the user’s real IP in Jellyfin’s activity panel we must:

- **Compute “client IP” per request in Subfin**  
  Use the **first** address in **X-Forwarded-For** (the original client when proxies append), or **X-Real-IP** if present, then fall back to **req.socket.remoteAddress**. Optionally support **Forwarded** (RFC 7239). Normalize IPv6 (e.g. strip `::ffff:`-style wrapping if desired).  
  **Trusted proxies:** To avoid spoofing, only use `X-Forwarded-For` when the **immediate** connection (e.g. `req.socket.remoteAddress`) is from a trusted proxy (configurable list, or single “proxy depth” so we only trust one hop). If Subfin is only ever run behind one reverse proxy, “use first X-Forwarded-For when present” may be enough; for hardened setups, document a config like `TRUSTED_PROXY_CIDRS` and only then take forwarded headers.

- **Thread client IP through the request**  
  Store the computed IP in request-scoped context (e.g. **AsyncLocalStorage** or a `req` property) so handlers and the Jellyfin layer can access it without changing every function signature. Optional: add it to **AuthResult** or the Jellyfin context object so it flows with auth.

- **Send it to Jellyfin on outbound requests**  
  When Subfin calls the Jellyfin API, set **X-Forwarded-For** (and optionally **X-Real-IP**) on the outbound HTTP request to the computed client IP. The Jellyfin SDK uses an Axios instance; we can pass a **custom Axios instance** (or use an **interceptor**) that adds this header from the request-scoped value (e.g. from AsyncLocalStorage) when present. That way the same cached API instance (per token/device) can be reused while each request still sends the correct client IP.  
  **Jellyfin server:** Subfin’s IP (or the reverse proxy in front of Subfin) must be in Jellyfin’s **Known Proxies** so Jellyfin trusts the header and uses it for RemoteEndPoint / activity. Document this in Subfin’s deployment docs.

**Summary:** Middleware (or first handler) computes client IP and stores it in request context; Jellyfin client uses an Axios interceptor to add `X-Forwarded-For: <clientIp>` on every outbound call when the context has a client IP; Jellyfin shows that IP in the activity panel when the server trusts Subfin as a proxy.

### 6. Edge cases

- **Token auth (t/s)**  
  We match by iterating `getDevicesForToken` and comparing the token. We must return the **matched** device’s id and label, not the first device. So `getDevicesForToken` must return `id` and `device_label` per device, and when we find a match we use that device’s id/label for `AuthResult`.
- **Sessions (no linked device yet)**  
  Before a device is linked, we use `jellyfin_sessions` (e.g. after Quick Connect). There is no “device” yet, so `jellyfinDeviceId` / `jellyfinDeviceName` stay unset and we keep using the global config for those requests. No change needed.
- **Playstate / reporting**  
  Playback reporting (scrobble, progress, start/stop) and any session/device reporting will then automatically use the per-device identity because they go through the same `createJellyfinApi(accessToken, device)`.
- **Client IP when no proxy**  
  When there is no X-Forwarded-For, client IP is `req.socket.remoteAddress`; it will still be sent to Jellyfin so the activity panel shows the address that connected to Subfin.

## Effort vs benefit

| Aspect | Estimate |
|--------|----------|
| **Store** | Small: extend return types and include id/label in 2 functions. |
| **Auth** | Small: extend `AuthResult` and set device fields in 2–3 code paths. |
| **Jellyfin client** | Medium: add context type + `getApi(ctx)`, change `createJellyfinApi` and cache key, then touch ~45 call sites (mechanical). For client IP: custom Axios instance or interceptor that adds X-Forwarded-For from request-scoped context. |
| **Handlers** | Medium: replace `auth.jellyfinAccessToken` (and similar) with a context object in many places; straightforward but numerous. |
| **Client IP** | Small–medium: middleware to compute client IP (X-Forwarded-For / X-Real-IP / remoteAddress, optional trusted-proxy config); request-scoped storage (AsyncLocalStorage or req); Jellyfin client adds header on outbound requests. |
| **Testing** | Link 2 devices with different labels, use both; confirm Jellyfin shows two devices with the right names. For IP: call from different clients/proxies and confirm activity panel shows correct IP; document Known Proxies for Jellyfin. |

**Benefits:**

- Each app-password (e.g. “SubTUI”, “DSub”, “Phone”) shows as a separate device in Jellyfin.
- Play queue and “now playing” could later be made per-device if Jellyfin supports it, without changing device identity again.
- Clearer dashboard and session list for users with multiple clients.
- Activity panel shows the **real client IP** (including behind a reverse proxy via X-Forwarded-For), so admins see which address each session came from instead of Subfin’s IP only.

**Risks:**

- Refactor touches auth, store, jellyfin client, and handlers; good test coverage and a staged rollout (e.g. store + auth first, then jellyfin + handlers) reduce risk.
- If any code path forgets to pass device context, that path will still use the global config and show as the single “Subfin Middleware” device (no worse than today).

## Recommendation

The change is **well-scoped and backward compatible**: when device info is missing we keep current behavior. It’s mostly mechanical (context type + threading it through). Doing it **now** makes future work (e.g. play queue per device) easier and improves the Jellyfin dashboard with little downside. **Worth taking on** if you want distinct devices in Jellyfin and are okay with a moderate refactor across store, auth, jellyfin client, and handlers.

## Suggested implementation order

1. **Store:** Have `resolveToJellyfinToken` and `getDevicesForToken` return device id and label; keep existing return shape and add fields.
2. **Auth:** Extend `AuthResult` with `jellyfinDeviceId` / `jellyfinDeviceName`; set them in `resolveAuth` and `resolveAuthFromBasicHeader` from the matched device.
3. **Jellyfin client:** Add `JellyfinContext`, `getApi(ctx)`, and optional device in `createJellyfinApi` (and cache key); switch all internal call sites to `getApi(ctx)`.
4. **Handlers:** Pass context object into every `jf.*` call that currently passes `auth.jellyfinAccessToken` (and userId where needed).
5. **Client IP:** Add middleware (or equivalent) to compute client IP from X-Forwarded-For / X-Real-IP / remoteAddress (with optional trusted-proxy config); store in request-scoped context (e.g. AsyncLocalStorage). In Jellyfin client, use a custom Axios instance or interceptor to add X-Forwarded-For (and optionally X-Real-IP) from that context on every outbound request. Document that Jellyfin’s Known Proxies must include Subfin (or the proxy in front of Subfin) for the activity panel to show the forwarded IP.
6. **Smoke test:** Two linked devices with different labels; confirm two distinct devices in Jellyfin with correct names. From different clients or behind a proxy, confirm activity panel shows the correct client IP.
