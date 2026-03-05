/**
 * Request-scoped context (e.g. client IP) for use when calling Jellyfin so the activity panel
 * shows the real client address. Uses AsyncLocalStorage so handlers don't need to thread IP explicitly.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

const storage = new AsyncLocalStorage<{ clientIp: string }>();

/** Get the client IP for the current request context, or undefined if not in a request. */
export function getClientIp(): string | undefined {
  return storage.getStore()?.clientIp;
}

/**
 * Derive client IP from the request. Prefers X-Forwarded-For (first/leftmost) or X-Real-IP
 * when behind a reverse proxy, then falls back to socket remote address.
 * Normalizes IPv6-mapped IPv4 (::ffff:1.2.3.4 -> 1.2.3.4).
 */
export function getClientIpFromRequest(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  let ip: string | undefined;
  if (forwarded) {
    const first = typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded[0];
    ip = first?.trim();
  }
  if (!ip) {
    const real = req.headers["x-real-ip"];
    ip = typeof real === "string" ? real.trim() : Array.isArray(real) ? real[0]?.trim() : undefined;
  }
  if (!ip && req.socket?.remoteAddress) {
    ip = req.socket.remoteAddress;
  }
  if (!ip) return "unknown";
  // Normalize IPv6-mapped IPv4
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

/** Express middleware: set request-scoped client IP so Jellyfin outbound requests can send X-Forwarded-For. */
export function clientIpMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const clientIp = getClientIpFromRequest(req);
  storage.run({ clientIp }, () => next());
}
