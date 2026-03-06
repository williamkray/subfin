/**
 * Per-IP rate limiting for share endpoints and failed share auth (brute-force mitigation).
 */
import type { Request, Response, NextFunction } from "express";
import { getClientIpFromRequest } from "../request-context.js";

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // share endpoints: 60/min per IP
const MAX_AUTH_FAIL_PER_WINDOW = 5; // failed (share_uid, secret): 5/min per IP

interface Window {
  count: number;
  resetAt: number;
}

const shareEndpointWindows = new Map<string, Window>();
const authFailWindows = new Map<string, Window>();

function getOrCreateWindow(map: Map<string, Window>, key: string, max: number): { allowed: boolean; window: Window } {
  const now = Date.now();
  let w = map.get(key);
  if (!w || w.resetAt < now) {
    w = { count: 0, resetAt: now + WINDOW_MS };
    map.set(key, w);
  }
  w.count++;
  const allowed = w.count <= max;
  return { allowed, window: w };
}

/** Middleware: limit share endpoint requests per IP (e.g. /share/:id, /share/:id/m3u, /share/:id/zip). */
export function shareEndpointRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIpFromRequest(req);
  const { allowed } = getOrCreateWindow(shareEndpointWindows, ip, MAX_REQUESTS_PER_WINDOW);
  if (!allowed) {
    res.status(429).setHeader("Retry-After", "60").send("Too many requests");
    return;
  }
  next();
}

/** Call when share auth failed (invalid secret). Returns true if under limit; if false, caller should send 429. */
export function recordShareAuthFailure(req: Request): boolean {
  const ip = getClientIpFromRequest(req);
  const { allowed } = getOrCreateWindow(authFailWindows, ip, MAX_AUTH_FAIL_PER_WINDOW);
  return allowed;
}
