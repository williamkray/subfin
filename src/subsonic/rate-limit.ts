/**
 * Rate limiting for /rest/ endpoints.
 * Uses the same in-memory sliding-window pattern as share-rate-limit.ts.
 */
import type { Request } from "express";
import { getClientIpFromRequest } from "../request-context.js";

interface Window {
  count: number;
  resetAt: number;
}

const authFailWindows = new Map<string, Window>();

function getOrCreateWindow(map: Map<string, Window>, key: string, windowMs: number): Window {
  const now = Date.now();
  let w = map.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    map.set(key, w);
  }
  return w;
}

const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 20;

/** Track auth failures. Returns true if the IP is now over the limit. Call on auth failure. */
export function recordRestAuthFailure(req: Request): boolean {
  const ip = getClientIpFromRequest(req);
  const w = getOrCreateWindow(authFailWindows, ip, AUTH_FAIL_WINDOW_MS);
  w.count++;
  return w.count > AUTH_FAIL_MAX;
}
