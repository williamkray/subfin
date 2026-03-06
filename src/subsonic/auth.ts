/**
 * Parse Subsonic-style auth (u, p or t+s, or apiKey) and resolve to Jellyfin token via store.
 */
import { createHash } from "node:crypto";
import type { JellyfinContext } from "../jellyfin/client.js";
import { resolveToJellyfinToken, getDevicesForToken, resolveShareAuth, getShareAuthByUid } from "../store/index.js";
import { validateShareToken } from "../web/share-tokens.js";
import type { SubsonicError } from "./response.js";

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

/** Validate and resolve auth. Returns AuthResult or Subsonic error object. */
export function resolveAuth(params: AuthParams): AuthResult | SubsonicError {
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
            shareId: shareUid,
            shareAllowedIds: resolved.allowedTrackIds,
          };
        }
      }
    }
    return { code: 40, message: "Wrong username or password." };
  }

  if (params.apiKey) {
    // apiKey: treat as app-specific password (stored in our store)
    password = params.apiKey;
  } else if (params.t && params.s) {
    // Token auth: t = md5(password + s), where "password" is the Subsonic app password we issued.
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
  } else if (params.p) {
    let p = params.p;
    if (p.startsWith("enc:")) {
      try {
        p = Buffer.from(p.slice(4), "hex").toString("utf-8");
      } catch {
        return { code: 40, message: "Wrong username or password." };
      }
    }
    password = p;
  }

  if (!password) {
    return { code: 10, message: "Required parameter 'p', 't'+'s', or 'apiKey' missing." };
  }

  const resolved = resolveToJellyfinToken(username, password);
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
 * Used as fallback for getCoverArt when some clients (e.g. image loaders) send credentials only in the header.
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
