/**
 * Signed share session cookie: share_uid + expiry, verified with HMAC so clients cannot forge.
 * Used for GET /share/:id (no secret in URL after first visit).
 */
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { getConfig } from "../config.js";
import { getShareAuthByUid } from "../store/index.js";
import type { AuthResult } from "../subsonic/auth.js";

const COOKIE_NAME = "subfin_share";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSalt(): Buffer {
  return getConfig().salt;
}

function sign(payload: string): string {
  const hmac = createHmac("sha256", getSalt());
  hmac.update(payload, "utf8");
  return payload + "." + hmac.digest("hex");
}

function verify(value: string): { shareUid: string; exp: number } | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac("sha256", getSalt()).update(payload, "utf8").digest("hex");
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { shareUid?: string; exp?: number };
    if (typeof obj.shareUid !== "string" || typeof obj.exp !== "number") return null;
    if (obj.exp < Date.now()) return null;
    return { shareUid: obj.shareUid, exp: obj.exp };
  } catch {
    return null;
  }
}

export function createShareCookiePayload(shareUid: string): string {
  const exp = Date.now() + TTL_MS;
  const payload = Buffer.from(JSON.stringify({ shareUid, exp }), "utf8").toString("base64url");
  return sign(payload);
}

export function setShareCookie(res: Response, shareUid: string): void {
  const value = createShareCookiePayload(shareUid);
  res.append("Set-Cookie", `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`);
}

export function clearShareCookie(res: Response): void {
  res.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function getShareSessionFromCookie(req: Request): { shareUid: string } | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const c of cookies) {
    if (c.startsWith(COOKIE_NAME + "=")) {
      const value = c.slice((COOKIE_NAME + "=").length).trim();
      const parsed = verify(value);
      if (parsed) return { shareUid: parsed.shareUid };
      return null;
    }
  }
  return null;
}

/**
 * Resolve AuthResult from a valid share cookie. Used by REST when u/p are not sent (e.g. player on share page).
 */
export function resolveAuthFromShareCookie(req: Request): AuthResult | null {
  const session = getShareSessionFromCookie(req);
  if (!session) return null;
  const auth = getShareAuthByUid(session.shareUid);
  if (!auth) return null;
  return {
    subsonicUsername: auth.subsonicUsername,
    jellyfinBaseUrl: auth.jellyfinUrl,
    jellyfinUserId: auth.jellyfinUserId,
    jellyfinAccessToken: auth.jellyfinAccessToken,
    jellyfinDeviceId: auth.jellyfinDeviceId,
    jellyfinDeviceName: auth.jellyfinDeviceName,
    shareId: session.shareUid,
    shareAllowedIds: auth.allowedTrackIds,
  };
}
