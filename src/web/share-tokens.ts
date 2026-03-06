/**
 * Short-lived tokens for share access (e.g. M3U URLs). Signed payload with TTL; no DB.
 */
import { createHmac } from "node:crypto";
import { getConfig } from "../config.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PREFIX = "st_";

function getSalt(): Buffer {
  return getConfig().salt;
}

function sign(payload: string): string {
  return createHmac("sha256", getSalt()).update(payload, "utf8").digest("hex");
}

/** Create a short-lived token for the given share. Use in M3U/zip URLs so clients don't need the long-lived secret. */
export function createShareToken(shareUid: string): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ shareUid, exp }), "utf8").toString("base64url");
  return PREFIX + payload + "." + sign(payload);
}

/** Validate token and return shareUid if valid and not expired. */
export function validateShareToken(token: string): string | null {
  if (!token || !token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = sign(payload);
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { shareUid?: string; exp?: number };
    if (typeof obj.shareUid !== "string" || typeof obj.exp !== "number") return null;
    if (obj.exp < Date.now()) return null;
    return obj.shareUid;
  } catch {
    return null;
  }
}
