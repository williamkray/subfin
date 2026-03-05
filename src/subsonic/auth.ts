/**
 * Parse Subsonic-style auth (u, p or t+s, or apiKey) and resolve to Jellyfin token via store.
 */
import { createHash } from "node:crypto";
import { resolveToJellyfinToken, getDevicesForToken } from "../store/index.js";
import type { SubsonicError } from "./response.js";

export interface AuthParams {
  u?: string;
  p?: string;
  t?: string;
  s?: string;
  apiKey?: string;
}

export interface AuthResult {
  subsonicUsername: string;
  jellyfinUserId: string;
  jellyfinAccessToken: string;
}

/** Validate and resolve auth. Returns AuthResult or Subsonic error object. */
export function resolveAuth(params: AuthParams): AuthResult | SubsonicError {
  const username = params.u?.trim();
  if (!username) {
    return { code: 10, message: "Required parameter 'u' (username) missing." };
  }

  let password: string | null = null;

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
        return {
          subsonicUsername: username,
          jellyfinUserId: d.jellyfin_user_id,
          jellyfinAccessToken: d.jellyfin_access_token,
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

  return {
    subsonicUsername: username,
    jellyfinUserId: resolved.jellyfinUserId,
    jellyfinAccessToken: resolved.jellyfinAccessToken,
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
    return {
      subsonicUsername: username,
      jellyfinUserId: resolved.jellyfinUserId,
      jellyfinAccessToken: resolved.jellyfinAccessToken,
    };
  } catch {
    return null;
  }
}
