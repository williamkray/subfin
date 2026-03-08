/**
 * Parse Subsonic-style auth (u, p or t+s, or apiKey) and resolve to Jellyfin token via store.
 * When no stored app password matches and client sends username + password, tries native Jellyfin
 * authentication (option B): each client gets a unique device id (from User-Agent + IP) so Jellyfin
 * tracks devices separately; no device is stored in Subfin.
 */
import { createHash } from "node:crypto";
import type { JellyfinContext } from "../jellyfin/client.js";
import { authenticateByNameWithDevice } from "../jellyfin/client.js";
import { resolveToJellyfinToken, getDevicesForToken, resolveShareAuth, getShareAuthByUid } from "../store/index.js";
import { validateShareToken } from "../web/share-tokens.js";
import type { SubsonicError } from "./response.js";

/** Optional client identity for native Jellyfin auth: stable device id per client. */
export interface AuthClientInfo {
  userAgent: string;
  clientIp: string;
}

export interface AuthParams {
  u?: string;
  p?: string;
  t?: string;
  s?: string;
  apiKey?: string;
  /** Short-lived share token (e.g. for M3U/zip URLs). */
  token?: string;
}

export interface AuthResult {
  subsonicUsername: string;
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  /** Set when auth is resolved from a linked device; used for Jellyfin device/session identity. */
  jellyfinDeviceId?: string;
  jellyfinDeviceName?: string;
  /** Set when auth is via share (share_uid + secret). Restrict stream/download/cover to these track ids. */
  shareId?: string;
  shareAllowedIds?: Set<string>;
}

function deviceDisplay(deviceId: number, deviceLabel: string | null): { id: string; name: string } {
  return {
    id: "subfin-" + deviceId,
    name: deviceLabel?.trim() ? deviceLabel : "Subfin Device " + deviceId,
  };
}

/** Derive a stable Jellyfin device id from client identity so the same client gets the same device. */
function nativeAuthDeviceId(clientInfo: AuthClientInfo): string {
  const input = (clientInfo.userAgent || "").trim() + "|" + (clientInfo.clientIp || "").trim();
  const hash = createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24);
  return "subfin-native-" + hash;
}

/** Human-readable device name for Jellyfin admin (native auth sessions). */
function nativeAuthDeviceName(clientInfo: AuthClientInfo): string {
  const ua = (clientInfo.userAgent || "").trim();
  const ip = (clientInfo.clientIp || "").trim();
  const part = ua ? ua.slice(0, 50) : ip || "native";
  return "Subfin: " + part;
}

/** Build JellyfinContext from AuthResult for use with jf.* calls (per-device identity when available). */
export function toJellyfinContext(auth: AuthResult): JellyfinContext {
  if (auth.jellyfinDeviceId && auth.jellyfinDeviceName) {
    return {
      accessToken: auth.jellyfinAccessToken,
      userId: auth.jellyfinUserId,
      deviceId: auth.jellyfinDeviceId,
      deviceName: auth.jellyfinDeviceName,
    };
  }
  return auth.jellyfinAccessToken;
}

/** Validate and resolve auth. Returns AuthResult or Subsonic error object.
 * When clientInfo is provided and no stored app password matches, tries Jellyfin username+password
 * (native auth); each client gets a unique device id so Jellyfin tracks sessions per device. */
export async function resolveAuth(
  params: AuthParams,
  clientInfo?: AuthClientInfo
): Promise<AuthResult | SubsonicError> {
  // Share auth via short-lived token (e.g. M3U/zip URLs)
  if (params.token?.trim()) {
    const tokenParam = params.token.trim();
    const shareUid = validateShareToken(tokenParam);
    if (shareUid) {
      const auth = getShareAuthByUid(shareUid);
      if (auth) {
        return {
          subsonicUsername: auth.subsonicUsername,
          jellyfinUserId: auth.jellyfinUserId,
          jellyfinAccessToken: auth.jellyfinAccessToken,
          jellyfinDeviceId: auth.jellyfinDeviceId,
          jellyfinDeviceName: auth.jellyfinDeviceName,
          shareId: shareUid,
          shareAllowedIds: auth.allowedTrackIds,
        };
      }
    }
    return { code: 40, message: "Invalid or expired token." };
  }

  const username = params.u?.trim();
  if (!username) {
    return { code: 10, message: "Required parameter 'u' (username) missing." };
  }

  let password: string | null = null;

  // Share auth: u=share_<share_uid>, p=secret
  if (username.startsWith("share_")) {
    const shareUid = username.slice(6).trim();
    if (!shareUid) return { code: 10, message: "Invalid share username." };
    if (params.p) {
      const p = params.p.startsWith("enc:")
        ? (() => {
            try {
              return Buffer.from(params.p!.slice(4), "hex").toString("utf-8");
            } catch {
              return "";
            }
          })()
        : params.p;
      if (p) {
        const resolved = resolveShareAuth(shareUid, p);
        if (resolved) {
          return {
            subsonicUsername: resolved.subsonicUsername,
            jellyfinUserId: resolved.jellyfinUserId,
            jellyfinAccessToken: resolved.jellyfinAccessToken,
            jellyfinDeviceId: resolved.jellyfinDeviceId,
            jellyfinDeviceName: resolved.jellyfinDeviceName,
            shareId: shareUid,
            shareAllowedIds: resolved.allowedTrackIds,
          };
        }
      }
    }
    return { code: 40, message: "Wrong username or password." };
  }

  // Prefer password (p) when present so Jellyfin pass-through works even if client also sends t+s.
  if (params.p) {
    let p = params.p;
    if (p.startsWith("enc:")) {
      try {
        p = Buffer.from(p.slice(4), "hex").toString("utf-8");
      } catch {
        return { code: 40, message: "Wrong username or password." };
      }
    }
    password = p;
  } else if (params.apiKey) {
    password = params.apiKey;
  } else if (params.t && params.s) {
    // Token auth: t = md5(password + s). We only have stored app passwords to verify.
    const devices = getDevicesForToken(username);
    for (const d of devices) {
      if (!d.app_password_plain) continue;
      const expected = computeToken(d.app_password_plain, params.s);
      if (expected === params.t) {
        const dev = deviceDisplay(d.device_id, d.device_label);
        return {
          subsonicUsername: username,
          jellyfinUserId: d.jellyfin_user_id,
          jellyfinAccessToken: d.jellyfin_access_token,
          jellyfinDeviceId: dev.id,
          jellyfinDeviceName: dev.name,
        };
      }
    }
    return { code: 40, message: "Wrong username or password." };
  }

  if (!password) {
    return { code: 10, message: "Required parameter 'p', 't'+'s', or 'apiKey' missing." };
  }

  let resolved = resolveToJellyfinToken(username, password);
  if (!resolved && clientInfo) {
    const deviceId = nativeAuthDeviceId(clientInfo);
    const deviceName = nativeAuthDeviceName(clientInfo);
    const auth = await authenticateByNameWithDevice(username, password, deviceId, deviceName);
    if (auth) {
      return {
        subsonicUsername: username,
        jellyfinUserId: auth.userId,
        jellyfinAccessToken: auth.accessToken,
        jellyfinDeviceId: deviceId,
        jellyfinDeviceName: deviceName,
      };
    }
  }
  if (!resolved) {
    return { code: 40, message: "Wrong username or password." };
  }
  const dev = deviceDisplay(resolved.deviceId, resolved.deviceLabel);
  return {
    subsonicUsername: username,
    jellyfinUserId: resolved.jellyfinUserId,
    jellyfinAccessToken: resolved.jellyfinAccessToken,
    jellyfinDeviceId: dev.id,
    jellyfinDeviceName: dev.name,
  };
}

/** Compute token for t/s auth (for clients that send password as t=md5(p+s), s=salt). Not used for resolution since we use app passwords. */
export function computeToken(password: string, salt: string): string {
  return createHash("md5").update(password + salt, "utf8").digest("hex");
}

/**
 * Try to resolve auth from Authorization: Basic base64(username:password).
 * Store only (sync). Used when we don't need Jellyfin fallback (e.g. getCoverArt token path).
 */
export function resolveAuthFromBasicHeader(
  authorization: string | undefined
): AuthResult | null {
  if (!authorization || !authorization.startsWith("Basic ")) return null;
  try {
    const b64 = authorization.slice(6).trim();
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null;
    const username = decoded.slice(0, colon).trim();
    const password = decoded.slice(colon + 1);
    if (!username) return null;
    const resolved = resolveToJellyfinToken(username, password);
    if (!resolved) return null;
    const dev = deviceDisplay(resolved.deviceId, resolved.deviceLabel);
    return {
      subsonicUsername: username,
      jellyfinUserId: resolved.jellyfinUserId,
      jellyfinAccessToken: resolved.jellyfinAccessToken,
      jellyfinDeviceId: dev.id,
      jellyfinDeviceName: dev.name,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve auth from Basic header, trying store then Jellyfin native auth.
 * Use when params auth failed and client may have sent credentials only in the header.
 */
export async function resolveAuthFromBasicHeaderWithJellyfin(
  authorization: string | undefined,
  clientInfo?: AuthClientInfo
): Promise<AuthResult | null> {
  if (!authorization || !authorization.startsWith("Basic ")) return null;
  try {
    const b64 = authorization.slice(6).trim();
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null;
    const username = decoded.slice(0, colon).trim();
    const password = decoded.slice(colon + 1);
    if (!username || !password) return null;
    const resolved = resolveToJellyfinToken(username, password);
    if (resolved) {
      const dev = deviceDisplay(resolved.deviceId, resolved.deviceLabel);
      return {
        subsonicUsername: username,
        jellyfinUserId: resolved.jellyfinUserId,
        jellyfinAccessToken: resolved.jellyfinAccessToken,
        jellyfinDeviceId: dev.id,
        jellyfinDeviceName: dev.name,
      };
    }
    if (clientInfo) {
      const deviceId = nativeAuthDeviceId(clientInfo);
      const deviceName = nativeAuthDeviceName(clientInfo);
      const auth = await authenticateByNameWithDevice(username, password, deviceId, deviceName);
      if (auth) {
        return {
          subsonicUsername: username,
          jellyfinUserId: auth.userId,
          jellyfinAccessToken: auth.accessToken,
          jellyfinDeviceId: deviceId,
          jellyfinDeviceName: deviceName,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to resolve auth from Authorization: Basic base64(username:token) when URL has u and s.
 * Some clients (e.g. Musly image loader) send getCoverArt with id,u,s in the URL and t in the header.
 */
export function resolveAuthFromBasicHeaderWithToken(
  authorization: string | undefined,
  usernameFromParams: string | undefined,
  saltFromParams: string | undefined
): AuthResult | null {
  if (!authorization || !authorization.startsWith("Basic ")) return null;
  const username = usernameFromParams?.trim();
  const salt = saltFromParams?.trim();
  if (!username || !salt) return null;
  try {
    const b64 = authorization.slice(6).trim();
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon <= 0) return null;
    const headerUser = decoded.slice(0, colon).trim();
    const tokenValue = decoded.slice(colon + 1);
    if (headerUser !== username || !tokenValue) return null;
    const devices = getDevicesForToken(username);
    for (const d of devices) {
      if (!d.app_password_plain) continue;
      const expected = computeToken(d.app_password_plain, salt);
      if (expected === tokenValue) {
        const dev = deviceDisplay(d.device_id, d.device_label);
        return {
          subsonicUsername: username,
          jellyfinUserId: d.jellyfin_user_id,
          jellyfinAccessToken: d.jellyfin_access_token,
          jellyfinDeviceId: dev.id,
          jellyfinDeviceName: dev.name,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
