/**
 * OpenSubsonic REST router: /rest/<method> or /rest/<method>.view
 */
import { type Request, type Response } from "express";
import http from "node:http";
import https from "node:https";
import type { AuthParams, AuthResult } from "./auth.js";
import {
  resolveAuth,
  resolveAuthFromBasicHeader,
  resolveAuthFromBasicHeaderWithJellyfin,
  resolveAuthFromBasicHeaderWithToken,
} from "./auth.js";
import { getClientIp } from "../request-context.js";
import { restRateLimit, recordRestAuthFailure } from "./rate-limit.js";
import { resolveAuthFromShareCookie } from "../web/share-session.js";
import { subsonicEnvelope, subsonicError, ErrorCode, VERSION } from "./response.js";
import * as handlers from "./handlers.js";
import { stripSubsonicIdPrefix } from "./mappers.js";
import { config } from "../config.js";
import { buildJellyfinAuthHeader } from "../jellyfin/client.js";

const HANDLERS: Record<
  string,
  (auth: AuthResult, params: Record<string, string>) => Promise<Record<string, unknown>>
> = {
  ping: async () => handlers.handlePing(),
  getlicense: async () => handlers.handleGetLicense(),
  getopensubsonicextensions: async () => handlers.handleGetOpenSubsonicExtensions(),
  getmusicfolders: async (auth) => handlers.handleGetMusicFolders(auth),
  getartists: async (auth, params) => handlers.handleGetArtists(auth, params),
  getindexes: async (auth, params) => handlers.handleGetIndexes(auth, params),
  getartist: async (auth, params) => handlers.handleGetArtist(auth, params),
  getmusicdirectory: async (auth, params) => handlers.handleGetMusicDirectory(auth, params),
  getalbum: async (auth, params) => handlers.handleGetAlbum(auth, params),
  getsong: async (auth, params) => handlers.handleGetSong(auth, params),
  getalbumlist: async (auth, params) => handlers.handleGetAlbumList(auth, params),
  getalbumlist2: async (auth, params) => handlers.handleGetAlbumList2(auth, params),
  getrandomsongs: async (auth, params) => handlers.handleGetRandomSongs(auth, params),
  getgenres: async (auth, params) => handlers.handleGetGenres(auth, params),
  getsongsbygenre: async (auth, params) => handlers.handleGetSongsByGenre(auth, params),
  getnowplaying: async (auth) => handlers.handleGetNowPlaying(auth),
  gettopsongs: async (auth, params) => handlers.handleGetTopSongs(auth, params),
  getsimilarsongs: async (auth, params) => handlers.handleGetSimilarSongs(auth, params),
  getsimilarsongs2: async (auth, params) => handlers.handleGetSimilarSongs2(auth, params),
  getlyrics: async (auth, params) => handlers.handleGetLyrics(auth, params),
  getlyricsbysongid: async (auth, params) => handlers.handleGetLyricsBySongId(auth, params),
  search3: async (auth, params) => handlers.handleSearch3(auth, params),
  // Legacy search endpoints delegate to search3 for data; XML shaping differs per method.
  search: async (auth, params) => handlers.handleSearch3(auth, params),
  search2: async (auth, params) => handlers.handleSearch3(auth, params),
  getuser: async (auth) => handlers.handleGetUser(auth),
  getusers: async (auth) => handlers.handleGetUsers(auth),
  getplaylists: async (auth) => handlers.handleGetPlaylists(auth),
  getplaylist: async (auth, params) => handlers.handleGetPlaylist(auth, params),
  createplaylist: async (auth, params) => handlers.handleCreatePlaylist(auth, params),
  updateplaylist: async (auth, params) => handlers.handleUpdatePlaylist(auth, params),
  deleteplaylist: async (auth, params) => handlers.handleDeletePlaylist(auth, params),
  getartistinfo: async (auth, params) => handlers.handleGetArtistInfo(auth, params),
  getartistinfo2: async (auth, params) => handlers.handleGetArtistInfo2(auth, params),
  getalbuminfo: async (auth, params) => handlers.handleGetAlbumInfo(auth, params),
  getalbuminfo2: async (auth, params) => handlers.handleGetAlbumInfo2(auth, params),
  getstarred: async (auth, params) => handlers.handleGetStarred(auth, params),
  getstarred2: async (auth, params) => handlers.handleGetStarred2(auth, params),
  scrobble: async (auth, params) => handlers.handleScrobble(auth, params),
  setrating: async (auth, params) => handlers.handleSetRating(auth, params),
  star: async (auth, params) => handlers.handleStar(auth, params),
  unstar: async (auth, params) => handlers.handleUnstar(auth, params),
  saveplayqueue: async (auth, params) => handlers.handleSavePlayQueue(auth, params),
  getplayqueue: async (auth) => handlers.handleGetPlayQueue(auth),
  saveplayqueuebyindex: async (auth, params) => handlers.handleSavePlayQueueByIndex(auth, params),
  getplayqueuebyindex: async (auth) => handlers.handleGetPlayQueueByIndex(auth),
  createshare: async (auth, params) => handlers.handleCreateShare(auth, params as unknown as { ids: string[]; description?: string; expires?: string }),
  getshares: async (auth) => handlers.handleGetShares(auth),
  updateshare: async (auth, params) => handlers.handleUpdateShare(auth, params),
  deleteshare: async (auth, params) => handlers.handleDeleteShare(auth, params),
};

function getParams(req: Request): Record<string, string> {
  const q = req.query as Record<string, string | string[] | undefined>;
  const body = (req.body as Record<string, string | string[] | undefined>) ?? {};
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== "") params[k] = Array.isArray(v) ? v[0] ?? "" : String(v);
  }
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== "" && params[k] === undefined)
      params[k] = Array.isArray(v) ? v[0] ?? "" : String(v);
  }
  return params;
}

/** Build auth params with case-insensitive keys (some clients send U, P, T, S). */
function getAuthParams(params: Record<string, string>): AuthParams {
  const one = (a: string, b: string) =>
    (params[a] ?? params[b])?.trim() || undefined;
  return {
    u: one("u", "U"),
    p: params.p ?? params.P,
    t: params.t ?? params.T,
    s: params.s ?? params.S,
    apiKey: params.apiKey ?? params.ApiKey,
    token: params.token ?? params.Token,
  };
}

/** Normalize a param value to a string id; avoid sending "[object Object]" when client sends an object. */
function toIdString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s !== "" && s !== "[object Object]" ? s : null;
  }
  if (typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const idKeys = ["id", "Id", "ID", "songId", "entryId", "value"];
  for (const key of idKeys) {
    if (key in o && typeof o[key] === "string") {
      const s = (o[key] as string).trim();
      if (s !== "" && s !== "[object Object]") return s;
    }
  }
  // Any key ending with "id" or "Id" (e.g. from serialized DSub Entry)
  for (const [key, val] of Object.entries(o)) {
    if (typeof val === "string" && /id$/i.test(key)) {
      const s = val.trim();
      if (s !== "" && s !== "[object Object]") return s;
    }
  }
  // Single string value (e.g. { "0": "abc" } from some serializers)
  const entries = Object.entries(o).filter(([, val]) => typeof val === "string");
  if (entries.length === 1) {
    const s = (entries[0]![1] as string).trim();
    if (s !== "" && s !== "[object Object]") return s;
  }
  // Last resort: any string that looks like a Subsonic/Jellyfin id (hex, or al-/ar-/pl- prefix + hex/guid)
  const idLike = /^(ar-|al-|pl-)?[a-fA-F0-9-]{32,36}$/;
  for (const val of Object.values(o)) {
    if (typeof val === "string") {
      const s = val.trim();
      if (s !== "" && s !== "[object Object]" && idLike.test(s)) return s;
    }
  }
  return null;
}

/** Collect multiple ids from a value (array or array-like object e.g. { "0": "id1", "1": "id2" }). */
function toIdStrings(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    const ids: string[] = [];
    for (const x of v) {
      const id = toIdString(x);
      if (id) ids.push(id);
    }
    return ids;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (keys.length > 0) {
      const ids: string[] = [];
      for (const k of keys) {
        const id = toIdString(o[k]);
        if (id) ids.push(id);
      }
      return ids;
    }
    const single = toIdString(v);
    return single ? [single] : [];
  }
  const single = toIdString(v);
  return single ? [single] : [];
}

/** Collect array-style params for playlist CRUD (songId, songIdToAdd, songIndexToRemove). */
function getPlaylistArrays(req: Request): {
  songIds: string[];
  songIdsToAdd: string[];
  songIndexesToRemove: number[];
} {
  const collect = (key: string): string[] => {
    const q = req.query as Record<string, unknown>;
    const body = (req.body as Record<string, unknown>) ?? {};
    const out: string[] = [];
    for (const [k, v] of Object.entries(q)) {
      if (k !== key && !k.startsWith(key + "[")) continue;
      out.push(...toIdStrings(v));
    }
    for (const [k, v] of Object.entries(body)) {
      if (k !== key && !k.startsWith(key + "[")) continue;
      out.push(...toIdStrings(v));
    }
    return out;
  };
  const songIds = collect("songId");
  const songIdsToAdd = collect("songIdToAdd");
  const rawIndexes = collect("songIndexToRemove");
  const songIndexesToRemove = rawIndexes
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
  return { songIds, songIdsToAdd, songIndexesToRemove };
}

/** Collect savePlayQueue params: multiple id, current, position, client name (c). */
function getPlayQueueSaveParams(req: Request): {
  playQueueIds: string[];
  current: string;
  position: string;
  changedBy: string;
} {
  const q = req.query as Record<string, unknown>;
  const body = (req.body as Record<string, unknown>) ?? {};
  const ids: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  for (const [k, v] of Object.entries(body)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  const one = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? String(v[0] ?? "") : String(v));
  const current = one(q.current ?? body.current).trim();
  const position = one(q.position ?? body.position).trim() || "0";
  const changedBy = one(q.c ?? body.c).trim();
  return { playQueueIds: ids, current, position, changedBy };
}

/** Collect savePlayQueueByIndex params: multiple id, currentIndex, position, client name (c). */
function getPlayQueueByIndexSaveParams(req: Request): {
  playQueueIds: string[];
  currentIndex: string;
  position: string;
  changedBy: string;
} {
  const q = req.query as Record<string, unknown>;
  const body = (req.body as Record<string, unknown>) ?? {};
  const ids: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  for (const [k, v] of Object.entries(body)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  const one = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? String(v[0] ?? "") : String(v));
  const currentIndex = one(q.currentIndex ?? body.currentIndex).trim() || "0";
  const position = one(q.position ?? body.position).trim() || "0";
  const changedBy = one(q.c ?? body.c).trim();
  return { playQueueIds: ids, currentIndex, position, changedBy };
}

/** Collect id[] and optional description/expires for createShare. */
function getCreateShareParams(req: Request): { ids: string[]; description?: string; expires?: string } {
  const q = req.query as Record<string, unknown>;
  const body = (req.body as Record<string, unknown>) ?? {};
  const ids: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  for (const [k, v] of Object.entries(body)) {
    if (k !== "id" && !k.startsWith("id[")) continue;
    ids.push(...toIdStrings(v));
  }
  const one = (v: unknown): string => (v === undefined || v === null ? "" : Array.isArray(v) ? String(v[0] ?? "") : String(v));
  return {
    ids,
    description: one(q.description ?? body.description).trim() || undefined,
    expires: one(q.expires ?? body.expires).trim() || undefined,
  };
}

/** Subsonic API default is XML; DSub and many clients omit f= and expect XML. */
function getFormat(params: Record<string, string>): "json" | "xml" {
  const f = params.f?.toLowerCase();
  if (f === "json") return "json";
  return "xml";
}

function sendError(
  res: Response,
  format: "json" | "xml",
  code: number,
  message: string,
  httpStatus: number = 200
): void {
  const body = subsonicError(code, message);
  if (format === "xml") {
    res.set("Content-Type", "application/xml");
    res.status(httpStatus).send(toXml(body));
    return;
  }
  res.status(httpStatus).json(body);
}

/** Device identity for Jellyfin proxy requests (stream, download, cover, avatar). */
function getDeviceForProxy(auth: { jellyfinDeviceId?: string; jellyfinDeviceName?: string }): { id: string; name: string } | undefined {
  return auth.jellyfinDeviceId && auth.jellyfinDeviceName
    ? { id: auth.jellyfinDeviceId, name: auth.jellyfinDeviceName }
    : undefined;
}

export async function subsonicRouter(req: Request, res: Response): Promise<void> {
  const rawParam = req.params.method ?? "";
  const raw = (typeof rawParam === "string" ? rawParam : rawParam[0] ?? "").replace(/\.view$/i, "").trim();
  const method = (raw || "ping").toLowerCase();

  const params = getParams(req);
  const format = getFormat(params);

  // Per-IP rate limit: applied before any auth or handler work.
  // Binary proxy endpoints are excluded: they are high-volume by design (one request per album
  // cover, per stream) and don't require brute-force protection since there are no secrets to guess.
  const isProxyEndpoint = method === "stream" || method === "download" || method === "getcoverart" || method === "getavatar";
  if (!isProxyEndpoint && restRateLimit(req)) {
    sendError(res, format, ErrorCode.Generic, "Too many requests", 429);
    return;
  }
  const authParams = getAuthParams(params);

  // Auth
  let authResult: Awaited<ReturnType<typeof resolveAuth>>;
  // getCoverArt: try Authorization: Basic first when present (some clients send creds only in header)
  if (method === "getcoverart" && req.get("authorization")?.startsWith("Basic ")) {
    const headerAuth = resolveAuthFromBasicHeader(req.get("authorization"));
    authResult = headerAuth ?? (await resolveAuth(authParams));
  } else {
    authResult = await resolveAuth(authParams);
  }
  // When u/p not sent (e.g. share page player with cookie), try share cookie
  if ("code" in authResult && authResult.code === 10) {
    const shareAuth = resolveAuthFromShareCookie(req);
    if (shareAuth) authResult = shareAuth;
  }
  // When params auth failed, try Authorization: Basic for any method
  if ("code" in authResult && req.get("authorization")?.startsWith("Basic ")) {
    const basicAuth = resolveAuthFromBasicHeaderWithJellyfin(req.get("authorization"));
    if (basicAuth) authResult = basicAuth;
  }
  // getCoverArt: additional fallbacks when params auth failed (image loader sends t in header, u+s in URL)
  if ("code" in authResult && method === "getcoverart") {
    const headerAuth = resolveAuthFromBasicHeader(req.get("authorization"));
    if (headerAuth) authResult = headerAuth;
    if ("code" in authResult) {
      const tokenHeaderAuth = resolveAuthFromBasicHeaderWithToken(
        req.get("authorization"),
        authParams.u,
        authParams.s
      );
      if (tokenHeaderAuth) authResult = tokenHeaderAuth;
    }
  }
  if (config.logRest) {
    const authLog = "code" in authResult ? `auth failed ${authResult.code}` : "auth ok";
    console.log(`[REST] ${req.method} ${req.path} method=${method} ${authLog}`);
    // Debug getCoverArt auth 40 to see what client sent (no secret values)
    if (method === "getcoverart" && "code" in authResult && authResult.code === 40) {
      const ah = req.get("authorization");
      const authType = !ah ? "none" : ah.startsWith("Basic ") ? "Basic" : ah.startsWith("Bearer ") ? "Bearer" : "other";
      console.log(
        `[REST_DEBUG] getCoverArt auth 40: id=${params.id ? "1" : "0"} u=${authParams.u ? "1" : "0"} p=${authParams.p ? "1" : "0"} t=${authParams.t ? "1" : "0"} s=${authParams.s ? "1" : "0"} authHeader=${authType}`
      );
    }
  }
  if ("code" in authResult) {
    const ip = getClientIp() ?? req.socket?.remoteAddress ?? "unknown";
    console.log(`[AUTH_FAIL] method=${method} ip=${ip} code=${authResult.code}`);
    if (recordRestAuthFailure(req)) {
      sendError(res, format, ErrorCode.Generic, "Too many requests", 429);
      return;
    }
    const httpStatus = authResult.code === 40 ? 401 : 200;
    sendError(res, format, authResult.code, authResult.message, httpStatus);
    return;
  }
  const auth = authResult;

  // Binary endpoints (stream/download/cover/avatar): always proxy from Jellyfin.
  if (method === "stream") {
    const id = params.id?.trim();
    if (!id) {
      sendError(res, format, ErrorCode.RequiredParameterMissing, "Missing id");
      return;
    }
    if (auth.shareAllowedIds && !auth.shareAllowedIds.has(stripSubsonicIdPrefix(id))) {
      sendError(res, format, ErrorCode.NotFound, "Not found", 404);
      return;
    }
    // Do not report playback start on stream: many clients pre-fetch the next track for gapless
    // playback, so we would mark the wrong track as "now playing". For "now playing" to update
    // when the queue auto-advances, the client must send scrobble(id, submission=false) when the
    // new track actually starts (not just when it's streamed for pre-fetch).
    try {
      const maxBitRateKbps = params.maxBitRate
        ? Number.parseInt(params.maxBitRate, 10) || undefined
        : undefined;
      const formatParam = params.format?.trim() || undefined;
      const url = handlers.getStreamRedirectUrl(auth, id, maxBitRateKbps, formatParam);
      if (config.logRest) {
        console.log(`[STREAM] url=${url}`);
      }
      proxyBinary(url, auth.jellyfinAccessToken, req, res, getDeviceForProxy(auth));
      return;
    } catch (err) {
      console.error("Error resolving stream URL", err);
      sendError(res, format, ErrorCode.NotFound, "Stream not found");
      return;
    }
  }

  if (method === "download") {
    const id = params.id?.trim();
    if (!id) {
      sendError(res, format, ErrorCode.RequiredParameterMissing, "Missing id");
      return;
    }
    if (auth.shareAllowedIds && !auth.shareAllowedIds.has(stripSubsonicIdPrefix(id))) {
      sendError(res, format, ErrorCode.NotFound, "Not found", 404);
      return;
    }
    try {
      const url = handlers.getDownloadRedirectUrl(auth, id);
      if (config.logRest) {
        console.log(`[DOWNLOAD] url=${url}`);
      }
      proxyBinary(url, auth.jellyfinAccessToken, req, res, getDeviceForProxy(auth));
      return;
    } catch (err) {
      console.error("Error resolving download URL", err);
      sendError(res, format, ErrorCode.NotFound, "Download not found");
      return;
    }
  }

  if (method === "getcoverart") {
    const id = params.id?.trim();
    if (!id) {
      sendError(res, format, ErrorCode.RequiredParameterMissing, "Missing id");
      return;
    }
    if (auth.shareAllowedIds && !auth.shareAllowedIds.has(stripSubsonicIdPrefix(id))) {
      sendError(res, format, ErrorCode.NotFound, "Not found", 404);
      return;
    }
    try {
      const size = params.size ? Number.parseInt(params.size, 10) || undefined : undefined;
      const url = handlers.getCoverArtRedirectUrl(auth, id, size);
      if (config.logRest) {
        console.log(`[COVER] id=${id} size=${size ?? "none"} url=${url}`);
      }
      if (!url) {
        sendError(res, format, ErrorCode.NotFound, "Cover art not found");
        return;
      }
      proxyBinary(url, auth.jellyfinAccessToken, req, res, getDeviceForProxy(auth));
      return;
    } catch (err) {
      sendError(res, format, ErrorCode.NotFound, "Cover art not found");
      return;
    }
  }

  if (method === "getavatar") {
    const username = params.username?.trim();
    const size = params.size ? Number.parseInt(params.size, 10) || undefined : undefined;
    const url = handlers.getAvatarRedirectUrl(auth, username || undefined, size);
    if (!url) {
      sendError(res, format, ErrorCode.NotFound, "Avatar not found");
      return;
    }
    proxyBinary(url, auth.jellyfinAccessToken, req, res, getDeviceForProxy(auth));
    return;
  }

  const handler = HANDLERS[method];
  if (!handler) {
    sendError(res, format, ErrorCode.Generic, `Unknown method: ${method}`);
    return;
  }

  if (method === "createplaylist" || method === "updateplaylist") {
    Object.assign(params, getPlaylistArrays(req));
  }
  if (method === "saveplayqueue") {
    Object.assign(params, getPlayQueueSaveParams(req));
  }
  if (method === "saveplayqueuebyindex") {
    Object.assign(params, getPlayQueueByIndexSaveParams(req));
  }
  if (method === "createshare") {
    Object.assign(params, getCreateShareParams(req));
  }

  // Share allowlist: when auth is share-scoped, only allow access to track ids in the share.
  if (method === "getsong" && auth.shareAllowedIds) {
    const id = params.id?.trim();
    if (!id || !auth.shareAllowedIds.has(stripSubsonicIdPrefix(id))) {
      sendError(res, format, ErrorCode.NotFound, "Not found", 404);
      return;
    }
  }

  handler(auth, params)
    .then((payload) => {
      if (config.logRest) {
        try {
          console.log(
            `[REST_RESULT] method=${method} format=${format} keys=${Object.keys(
              payload ?? {}
            ).join(",")}`
          );
          if (method === "getgenres") {
            console.log("[GENRES_PAYLOAD]", JSON.stringify(payload));
          }
        } catch {
          // ignore logging errors
        }
      }
      if (format === "xml") {
        // Hand-crafted XML for compatibility with classic Subsonic clients like DSub.
        let xml: string | null = null;
        if (method === "getlicense") {
          xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<subsonic-response status="ok" version="${VERSION}">` +
            '<license valid="true"/>' +
            "</subsonic-response>";
        } else if (method === "getmusicfolders") {
          const folders = (payload as any).musicFolders?.musicFolder ?? [];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<musicFolders>",
          ];
          for (const f of folders) {
            parts.push(
              `<musicFolder id="${escapeXmlAttr(String(f.id ?? ""))}" name="${escapeXmlAttr(
                String(f.name ?? "")
              )}"/>`
            );
          }
          parts.push("</musicFolders>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getindexes") {
          const idx = (payload as any).indexes ?? {};
          const indices = (idx.index ?? []) as any[];
          const lastModified = idx.lastModified ?? Date.now();
          const ignored = idx.ignoredArticles ?? "";
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            `<indexes lastModified="${lastModified}" ignoredArticles="${escapeXmlAttr(String(ignored))}">`,
          ];
          for (const i of indices) {
            const name = i.name ?? "#";
            const artists = (i.artist ?? []) as any[];
            parts.push(`<index name="${escapeXmlAttr(String(name))}">`);
            for (const a of artists) {
              parts.push(
                `<artist id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
                  String(a.name ?? "")
                )}"` +
                  (a.coverArt ? ` coverArt="${escapeXmlAttr(String(a.coverArt))}"` : "") +
                  (a.albumCount != null ? ` albumCount="${a.albumCount}"` : "") +
                  "/>"
              );
            }
            parts.push("</index>");
          }
          parts.push("</indexes>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getalbumlist") {
          const list = (payload as any).albumList ?? {};
          const albums = (list.album ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<albumList>",
          ];
          for (const a of albums) {
            let tag = `<album id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
              String(a.name ?? "")
            )}"`;
            if (a.artist) tag += ` artist="${escapeXmlAttr(String(a.artist))}"`;
            if (a.artistId) tag += ` artistId="${escapeXmlAttr(String(a.artistId))}"`;
            if (a.coverArt) tag += ` coverArt="${escapeXmlAttr(String(a.coverArt))}"`;
            if (a.songCount != null) tag += ` songCount="${a.songCount}"`;
            if (a.year != null) tag += ` year="${a.year}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</albumList>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getalbumlist2") {
          const list = (payload as any).albumList ?? {};
          const albums = (list.album ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<albumList2>",
          ];
          for (const a of albums) {
            let tag = `<album id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
              String(a.name ?? "")
            )}"`;
            if (a.artist) tag += ` artist="${escapeXmlAttr(String(a.artist))}"`;
            if (a.artistId) tag += ` artistId="${escapeXmlAttr(String(a.artistId))}"`;
            if (a.coverArt) tag += ` coverArt="${escapeXmlAttr(String(a.coverArt))}"`;
            if (a.songCount != null) tag += ` songCount="${a.songCount}"`;
            if (a.year != null) tag += ` year="${a.year}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</albumList2>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getrandomsongs") {
          const rs = (payload as any).randomSongs ?? {};
          const songs = (rs.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<randomSongs>",
          ];
          for (const c of songs) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</randomSongs>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getgenres") {
          const gs = (payload as any).genres ?? {};
          const genres = (gs.genre ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<genres>",
          ];
          for (const g of genres) {
            const value = g.value ?? g.name ?? "";
            const songCount = g.songCount ?? 0;
            const albumCount = g.albumCount ?? 0;
            parts.push(
              `<genre songCount="${songCount}" albumCount="${albumCount}" value="${escapeXmlAttr(
                String(value)
              )}">` +
                escapeXmlAttr(String(value)) +
                "</genre>"
            );
          }
          parts.push("</genres>", "</subsonic-response>");
          xml = parts.join("");
          if (config.logRest) {
            console.log("[GENRES_XML]", xml);
          }
        } else if (method === "getsongsbygenre") {
          const sbg = (payload as any).songsByGenre ?? {};
          const songs = (sbg.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<songsByGenre>",
          ];
          for (const c of songs as any[]) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</songsByGenre>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "gettopsongs") {
          const ts = (payload as any).topSongs ?? {};
          const songs = (ts.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<topSongs>",
          ];
          for (const c of songs as any[]) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</topSongs>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getsimilarsongs") {
          const ss = (payload as any).similarSongs ?? {};
          const songs = (ss.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<similarSongs>",
          ];
          for (const c of songs as any[]) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</similarSongs>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getsimilarsongs2") {
          const ss = (payload as any).similarSongs2 ?? {};
          const songs = (ss.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<similarSongs2>",
          ];
          for (const c of songs as any[]) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</similarSongs2>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getlyrics") {
          const lr = (payload as any).lyrics ?? {};
          const artist = escapeXmlAttr(String(lr.artist ?? ""));
          const title = escapeXmlAttr(String(lr.title ?? ""));
          const value = escapeXml(String(lr.value ?? ""));
          xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<subsonic-response status="ok" version="${VERSION}">` +
            `<lyrics artist="${artist}" title="${title}">${value}</lyrics>` +
            "</subsonic-response>";
        } else if (method === "getlyricsbysongid") {
          const list = (payload as any).lyricsList ?? {};
          const structured = (list.structuredLyrics ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<lyricsList>",
          ];
          for (const sl of structured) {
            let attrs = ` displayArtist="${escapeXmlAttr(String(sl.displayArtist ?? ""))}" displayTitle="${escapeXmlAttr(String(sl.displayTitle ?? ""))}"`;
            if (sl.lang != null) attrs += ` lang="${escapeXmlAttr(String(sl.lang))}"`;
            if (sl.offset != null) attrs += ` offset="${sl.offset}"`;
            attrs += ` synced="${sl.synced === true ? "true" : "false"}"`;
            parts.push(`<structuredLyrics${attrs}>`);
            for (const lineEntry of sl.line ?? []) {
            const lineVal = escapeXml(String(lineEntry.value ?? ""));
            if (lineEntry.start != null) {
              parts.push(`<line start="${lineEntry.start}">${lineVal}</line>`);
            } else {
              parts.push(`<line>${lineVal}</line>`);
            }
          }
            parts.push("</structuredLyrics>");
          }
          parts.push("</lyricsList>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getnowplaying") {
          const np = (payload as any).nowPlaying ?? {};
          const entries = (np.entry ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<nowPlaying>",
          ];
          for (const e of entries as any[]) {
            let tag = `<entry id="${escapeXmlAttr(String(e.id ?? ""))}"`;
            if (e.parent) tag += ` parent="${escapeXmlAttr(String(e.parent))}"`;
            if (e.title) tag += ` title="${escapeXmlAttr(String(e.title))}"`;
            if (e.album) tag += ` album="${escapeXmlAttr(String(e.album))}"`;
            if (e.artist) tag += ` artist="${escapeXmlAttr(String(e.artist))}"`;
            if (e.coverArt) tag += ` coverArt="${escapeXmlAttr(String(e.coverArt))}"`;
            if (e.track != null) tag += ` track="${e.track}"`;
            if (e.year != null) tag += ` year="${e.year}"`;
            if (e.genre) tag += ` genre="${escapeXmlAttr(String(e.genre))}"`;
            if (e.size != null) tag += ` size="${e.size}"`;
            if (e.duration != null) tag += ` duration="${e.duration}"`;
            if (e.bitRate != null) tag += ` bitRate="${e.bitRate}"`;
            if (e.path) tag += ` path="${escapeXmlAttr(String(e.path))}"`;
            if (e.isVideo) tag += ` isVideo="${e.isVideo ? "true" : "false"}"`;
            if (e.discNumber != null) tag += ` discNumber="${e.discNumber}"`;
            if (e.type) tag += ` type="${escapeXmlAttr(String(e.type))}"`;
            if (e.mediaType) tag += ` mediaType="${escapeXmlAttr(String(e.mediaType))}"`;
            if (e.suffix) tag += ` suffix="${escapeXmlAttr(String(e.suffix))}"`;
            if (e.contentType) tag += ` contentType="${escapeXmlAttr(String(e.contentType))}"`;
            if (e.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(e.transcodedSuffix))}"`;
            if (e.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(e.transcodedContentType))}"`;
            if (e.username) tag += ` username="${escapeXmlAttr(String(e.username))}"`;
            if (e.minutesAgo != null) tag += ` minutesAgo="${e.minutesAgo}"`;
            if (e.playerId) tag += ` playerId="${escapeXmlAttr(String(e.playerId))}"`;
            if (e.playerName) tag += ` playerName="${escapeXmlAttr(String(e.playerName))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</nowPlaying>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getmusicdirectory") {
          const md = (payload as any).directory ?? {};
          const children = (md.child ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            `<musicDirectory id="${escapeXmlAttr(String(md.id ?? ""))}" name="${escapeXmlAttr(
              String(md.name ?? "")
            )}">`,
          ];
          for (const c of children) {
            let tag = `<child id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.isDir) tag += ` isDir="true"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</musicDirectory>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "search" || method === "search2" || method === "search3") {
          const sr = (payload as any).searchResult3 ?? {};
          const artists = (sr.artist ?? []) as any[];
          const albums = (sr.album ?? []) as any[];
          const songs = (sr.song ?? []) as any[];
          const rootTag =
            method === "search"
              ? "searchResult"
              : method === "search2"
              ? "searchResult2"
              : "searchResult3";
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            `<${rootTag}>`,
          ];
          for (const a of artists) {
            let tag = `<artist id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
              String(a.name ?? "")
            )}"`;
            if (a.coverArt) tag += ` coverArt="${escapeXmlAttr(String(a.coverArt))}"`;
            if (a.albumCount != null) tag += ` albumCount="${a.albumCount}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const al of albums as any[]) {
            let tag = `<album id="${escapeXmlAttr(String(al.id ?? ""))}"`;
            if (al.parent) tag += ` parent="${escapeXmlAttr(String(al.parent))}"`;
            if (al.title) tag += ` title="${escapeXmlAttr(String(al.title))}"`;
            if (al.album) tag += ` album="${escapeXmlAttr(String(al.album))}"`;
            if (al.artist) tag += ` artist="${escapeXmlAttr(String(al.artist))}"`;
            if (al.isDir) tag += ` isDir="true"`;
            if (al.coverArt) tag += ` coverArt="${escapeXmlAttr(String(al.coverArt))}"`;
            if (al.track != null) tag += ` track="${al.track}"`;
            if (al.year != null) tag += ` year="${al.year}"`;
            if (al.genre) tag += ` genre="${escapeXmlAttr(String(al.genre))}"`;
            if (al.size != null) tag += ` size="${al.size}"`;
            if (al.duration != null) tag += ` duration="${al.duration}"`;
            if (al.bitRate != null) tag += ` bitRate="${al.bitRate}"`;
            if (al.path) tag += ` path="${escapeXmlAttr(String(al.path))}"`;
            if (al.isVideo) tag += ` isVideo="${al.isVideo ? "true" : "false"}"`;
            if (al.discNumber != null) tag += ` discNumber="${al.discNumber}"`;
            if (al.type) tag += ` type="${escapeXmlAttr(String(al.type))}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const c of songs as any[]) {
            let tag = `<song id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            if (c.mediaType) tag += ` mediaType="${escapeXmlAttr(String(c.mediaType))}"`;
            if (c.suffix) tag += ` suffix="${escapeXmlAttr(String(c.suffix))}"`;
            if (c.contentType) tag += ` contentType="${escapeXmlAttr(String(c.contentType))}"`;
            if (c.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(c.transcodedSuffix))}"`;
            if (c.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(c.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push(`</${rootTag}>`, "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getuser") {
          const u = (payload as any).user ?? {};
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            `<user username="${escapeXmlAttr(String(u.username ?? ""))}" email="${escapeXmlAttr(
              String(u.email ?? "")
            )}"/>`,
            "</subsonic-response>",
          ];
          xml = parts.join("");
        } else if (method === "getusers") {
          const users = (payload as any).users?.user ?? [];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<users>",
          ];
          for (const u of users as any[]) {
            parts.push(
              `<user username="${escapeXmlAttr(String(u.username ?? ""))}" email="${escapeXmlAttr(
                String(u.email ?? "")
              )}"/>`
            );
          }
          parts.push("</users>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getplaylists") {
          const playlists = (payload as any).playlists?.playlist ?? [];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<playlists>",
          ];
          for (const p of playlists as any[]) {
            let tag = `<playlist id="${escapeXmlAttr(String(p.id ?? ""))}" name="${escapeXmlAttr(
              String(p.name ?? "")
            )}"`;
            if (p.owner) tag += ` owner="${escapeXmlAttr(String(p.owner))}"`;
            if (p.comment) tag += ` comment="${escapeXmlAttr(String(p.comment))}"`;
            if (p.songCount != null) tag += ` songCount="${p.songCount}"`;
            if (p.public != null) tag += ` public="${p.public ? "true" : "false"}"`;
            if (p.created) tag += ` created="${escapeXmlAttr(String(p.created))}"`;
            if (p.changed) tag += ` changed="${escapeXmlAttr(String(p.changed))}"`;
            if (p.duration != null) tag += ` duration="${p.duration}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</playlists>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getplaylist") {
          const pl = (payload as any).playlist ?? {};
          const entries = (pl.entry ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            `<playlist id="${escapeXmlAttr(String(pl.id ?? ""))}" name="${escapeXmlAttr(
              String(pl.name ?? "")
            )}">`,
          ];
          for (const c of entries) {
            let tag = `<entry id="${escapeXmlAttr(String(c.id ?? ""))}"`;
            if (c.parent) tag += ` parent="${escapeXmlAttr(String(c.parent))}"`;
            if (c.title) tag += ` title="${escapeXmlAttr(String(c.title))}"`;
            if (c.album) tag += ` album="${escapeXmlAttr(String(c.album))}"`;
            if (c.artist) tag += ` artist="${escapeXmlAttr(String(c.artist))}"`;
            if (c.coverArt) tag += ` coverArt="${escapeXmlAttr(String(c.coverArt))}"`;
            if (c.track != null) tag += ` track="${c.track}"`;
            if (c.year != null) tag += ` year="${c.year}"`;
            if (c.genre) tag += ` genre="${escapeXmlAttr(String(c.genre))}"`;
            if (c.size != null) tag += ` size="${c.size}"`;
            if (c.duration != null) tag += ` duration="${c.duration}"`;
            if (c.bitRate != null) tag += ` bitRate="${c.bitRate}"`;
            if (c.path) tag += ` path="${escapeXmlAttr(String(c.path))}"`;
            if (c.isVideo) tag += ` isVideo="${c.isVideo ? "true" : "false"}"`;
            if (c.discNumber != null) tag += ` discNumber="${c.discNumber}"`;
            if (c.type) tag += ` type="${escapeXmlAttr(String(c.type))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</playlist>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "createplaylist") {
          const pl = (payload as any).playlist ?? {};
          xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<subsonic-response status="ok" version="${VERSION}">` +
            `<playlist id="${escapeXmlAttr(String(pl.id ?? ""))}" name="${escapeXmlAttr(
              String(pl.name ?? "")
            )}"/>` +
            "</subsonic-response>";
        } else if (method === "updateplaylist" || method === "deleteplaylist") {
          xml =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            `<subsonic-response status="ok" version="${VERSION}"/>`;
        } else if (method === "getartistinfo" || method === "getartistinfo2") {
          const ai = ((payload as any).artistInfo ?? (payload as any).artistInfo2) ?? {};
          const similars = (ai.similarArtist ?? []) as any[];
          const root = method === "getartistinfo2" ? "artistInfo2" : "artistInfo";
          const nameAttr =
            ai.name != null && String(ai.name).trim() !== ""
              ? ` name="${escapeXmlAttr(String(ai.name).trim())}"`
              : "";
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<" + root + nameAttr + ">",
          ];
          if (ai.name != null) {
            parts.push(`<name>${escapeXml(String(ai.name))}</name>`);
          }
          if (ai.biography != null) {
            parts.push(`<biography>${escapeXml(String(ai.biography))}</biography>`);
          }
          if (ai.musicBrainzId != null) {
            parts.push(
              `<musicBrainzId>${escapeXml(String(ai.musicBrainzId))}</musicBrainzId>`
            );
          }
          if (ai.lastFmUrl != null) {
            parts.push(`<lastFmUrl>${escapeXml(String(ai.lastFmUrl))}</lastFmUrl>`);
          }
          if (ai.smallImageUrl != null) {
            parts.push(`<smallImageUrl>${escapeXml(String(ai.smallImageUrl))}</smallImageUrl>`);
          }
          if (ai.mediumImageUrl != null) {
            parts.push(`<mediumImageUrl>${escapeXml(String(ai.mediumImageUrl))}</mediumImageUrl>`);
          }
          if (ai.largeImageUrl != null) {
            parts.push(
              `<largeImageUrl>${escapeXml(String(ai.largeImageUrl))}</largeImageUrl>`
            );
          }
          for (const s of similars) {
            parts.push(
              `<similarArtist id="${escapeXmlAttr(String(s.id ?? "-1"))}" name="${escapeXmlAttr(
                String(s.name ?? "")
              )}"` +
                (s.coverArt ? ` coverArt="${escapeXmlAttr(String(s.coverArt))}"` : "") +
                (s.starred ? ' starred="true"' : "") +
                "/>"
            );
          }
          parts.push("</" + root + ">", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getstarred") {
          const st = (payload as any).starred ?? {};
          const artists = (st.artist ?? []) as any[];
          const albums = (st.album ?? []) as any[];
          const songs = (st.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<starred>",
          ];
          for (const a of artists) {
            let tag = `<artist id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
              String(a.name ?? "")
            )}"`;
            if (a.coverArt != null && a.coverArt !== "") tag += ` coverArt="${escapeXmlAttr(String(a.coverArt))}"`;
            if (a.albumCount != null) tag += ` albumCount="${a.albumCount}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const al of albums) {
            let tag = `<album id="${escapeXmlAttr(String(al.id ?? ""))}" name="${escapeXmlAttr(
              String(al.name ?? "")
            )}"`;
            if (al.artist) tag += ` artist="${escapeXmlAttr(String(al.artist))}"`;
            if (al.artistId) tag += ` artistId="${escapeXmlAttr(String(al.artistId))}"`;
            if (al.coverArt) tag += ` coverArt="${escapeXmlAttr(String(al.coverArt))}"`;
            if (al.created) tag += ` created="${escapeXmlAttr(String(al.created))}"`;
            if (al.songCount != null) tag += ` songCount="${al.songCount}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const s of songs) {
            let tag = `<song id="${escapeXmlAttr(String(s.id ?? ""))}"`;
            if (s.parent) tag += ` parent="${escapeXmlAttr(String(s.parent))}"`;
            if (s.title) tag += ` title="${escapeXmlAttr(String(s.title))}"`;
            if (s.album) tag += ` album="${escapeXmlAttr(String(s.album))}"`;
            if (s.artist) tag += ` artist="${escapeXmlAttr(String(s.artist))}"`;
            if (s.coverArt) tag += ` coverArt="${escapeXmlAttr(String(s.coverArt))}"`;
            if (s.track != null) tag += ` track="${s.track}"`;
            if (s.year != null) tag += ` year="${s.year}"`;
            if (s.genre) tag += ` genre="${escapeXmlAttr(String(s.genre))}"`;
            if (s.size != null) tag += ` size="${s.size}"`;
            if (s.duration != null) tag += ` duration="${s.duration}"`;
            if (s.bitRate != null) tag += ` bitRate="${s.bitRate}"`;
            if (s.path) tag += ` path="${escapeXmlAttr(String(s.path))}"`;
            if (s.isVideo) tag += ` isVideo="${s.isVideo ? "true" : "false"}"`;
            if (s.discNumber != null) tag += ` discNumber="${s.discNumber}"`;
            if (s.type) tag += ` type="${escapeXmlAttr(String(s.type))}"`;
            if (s.mediaType) tag += ` mediaType="${escapeXmlAttr(String(s.mediaType))}"`;
            if (s.suffix) tag += ` suffix="${escapeXmlAttr(String(s.suffix))}"`;
            if (s.contentType) tag += ` contentType="${escapeXmlAttr(String(s.contentType))}"`;
            if (s.transcodedSuffix)
              tag += ` transcodedSuffix="${escapeXmlAttr(String(s.transcodedSuffix))}"`;
            if (s.transcodedContentType)
              tag += ` transcodedContentType="${escapeXmlAttr(String(s.transcodedContentType))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</starred>", "</subsonic-response>");
          xml = parts.join("");
        } else if (method === "getstarred2") {
          const st = (payload as any).starred2 ?? {};
          const artists = (st.artist ?? []) as any[];
          const albums = (st.album ?? []) as any[];
          const songs = (st.song ?? []) as any[];
          const parts: string[] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<subsonic-response status="ok" version="${VERSION}">`,
            "<starred2>",
          ];
          for (const a of artists) {
            let tag = `<artist id="${escapeXmlAttr(String(a.id ?? ""))}" name="${escapeXmlAttr(
              String(a.name ?? "")
            )}"`;
            if (a.coverArt != null && a.coverArt !== "") tag += ` coverArt="${escapeXmlAttr(String(a.coverArt))}"`;
            if (a.albumCount != null) tag += ` albumCount="${a.albumCount}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const al of albums) {
            let tag = `<album id="${escapeXmlAttr(String(al.id ?? ""))}" name="${escapeXmlAttr(
              String(al.name ?? "")
            )}"`;
            if (al.artist) tag += ` artist="${escapeXmlAttr(String(al.artist))}"`;
            if (al.artistId) tag += ` artistId="${escapeXmlAttr(String(al.artistId))}"`;
            if (al.coverArt) tag += ` coverArt="${escapeXmlAttr(String(al.coverArt))}"`;
            if (al.created) tag += ` created="${escapeXmlAttr(String(al.created))}"`;
            if (al.songCount != null) tag += ` songCount="${al.songCount}"`;
            tag += "/>";
            parts.push(tag);
          }
          for (const s of songs) {
            let tag = `<song id="${escapeXmlAttr(String(s.id ?? ""))}"`;
            if (s.parent) tag += ` parent="${escapeXmlAttr(String(s.parent))}"`;
            if (s.title) tag += ` title="${escapeXmlAttr(String(s.title))}"`;
            if (s.album) tag += ` album="${escapeXmlAttr(String(s.album))}"`;
            if (s.artist) tag += ` artist="${escapeXmlAttr(String(s.artist))}"`;
            if (s.coverArt) tag += ` coverArt="${escapeXmlAttr(String(s.coverArt))}"`;
            if (s.track != null) tag += ` track="${s.track}"`;
            if (s.year != null) tag += ` year="${s.year}"`;
            if (s.genre) tag += ` genre="${escapeXmlAttr(String(s.genre))}"`;
            if (s.size != null) tag += ` size="${s.size}"`;
            if (s.duration != null) tag += ` duration="${s.duration}"`;
            if (s.bitRate != null) tag += ` bitRate="${s.bitRate}"`;
            if (s.path) tag += ` path="${escapeXmlAttr(String(s.path))}"`;
            if (s.isVideo) tag += ` isVideo="${s.isVideo ? "true" : "false"}"`;
            if (s.discNumber != null) tag += ` discNumber="${s.discNumber}"`;
            if (s.type) tag += ` type="${escapeXmlAttr(String(s.type))}"`;
            tag += "/>";
            parts.push(tag);
          }
          parts.push("</starred2>", "</subsonic-response>");
          xml = parts.join("");
        }

        if (xml != null) {
          res.set("Content-Type", "application/xml");
          res.send(xml);
          return;
        }

        // Fallback: generic XML for methods that don't need strict Subsonic compatibility.
        const envelope = subsonicEnvelope(payload);
        res.set("Content-Type", "application/xml");
        res.send(toXml(envelope));
        return;
      }
      const envelope = subsonicEnvelope(payload);
      res.json(envelope);
    })
    .catch((err) => {
      if (err?.message === "NotFound") {
        sendError(res, format, ErrorCode.NotFound, "Not found");
        return;
      }
      if (err?.message === "Missing id") {
        sendError(
          res,
          format,
          ErrorCode.RequiredParameterMissing,
          "Required parameter 'id' is missing."
        );
        return;
      }
      if (err?.message === "No valid audio entries found for the given ids") {
        sendError(
          res,
          format,
          ErrorCode.Generic,
          "No playable tracks found for the given id(s). Use track, album (al-), or playlist ids."
        );
        return;
      }
      // Do not invalidate tokens on 401 here: by this point Subfin auth succeeded, so any
      // 401 is from Jellyfin (e.g. forbidden for shared playlist), not bad credentials.
      // Invalidating would wipe the user's session incorrectly.
      if (err?.code === 50 || (err?.message && String(err.message).includes("Not allowed"))) {
        sendError(
          res,
          format,
          ErrorCode.Generic,
          err?.message ?? "Not allowed to modify this playlist.",
          403
        );
        return;
      }
      if ((err as NodeJS.ErrnoException)?.code === "OutOfRange") {
        sendError(res, format, ErrorCode.Generic, err?.message ?? "Index out of range");
        return;
      }
      console.error(err);
      sendError(res, format, ErrorCode.Generic, err?.message ?? "Internal error");
    });
}

function toXml(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string") return escapeXml(obj);
  if (typeof obj !== "object") return String(obj);
  const entries = Object.entries(obj as Record<string, unknown>);
  const parts: string[] = [];
  for (const [key, value] of entries) {
    const tag = key.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          parts.push(`<${tag}>${toXml(item)}</${tag}>`);
        } else {
          parts.push(`<${tag}>${toXml(item)}</${tag}>`);
        }
      }
    } else {
      parts.push(`<${tag}>${toXml(value)}</${tag}>`);
    }
  }
  return parts.join("");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeXmlAttr(s: string): string {
  return escapeXml(s);
}

function proxyBinary(
  url: string,
  accessToken: string,
  clientReq: Request,
  clientRes: Response,
  device?: { id: string; name: string }
): void {
  try {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const agent = isHttps ? https : http;

    const headers: http.OutgoingHttpHeaders = {};
    if (clientReq.headers.range) {
      headers.range = clientReq.headers.range as string;
    }
    headers.Authorization = buildJellyfinAuthHeader(accessToken, device);
    if (config.logRest) {
      console.log("[STREAM_PROXY_REQ]", {
        range: headers.range ?? null,
      });
    }

    const MAX_PROXY_BYTES = 500 * 1024 * 1024; // 500MB — covers large lossless files

    const proxyReq = agent.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (proxyRes) => {
        if (config.logRest) {
          console.log(
            `[STREAM_PROXY] status=${proxyRes.statusCode} ct=${proxyRes.headers["content-type"] ?? ""} len=${proxyRes.headers["content-length"] ?? ""}`
          );
        }
        clientRes.status(proxyRes.statusCode ?? 200);
        const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding"]);
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!value) continue;
          if (hopByHop.has(key.toLowerCase())) continue;
          clientRes.setHeader(key, value as string);
        }
        let bytes = 0;
        proxyRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_PROXY_BYTES) {
            proxyReq.destroy(new Error("upstream response too large"));
            try { clientRes.destroy(); } catch { /* ignore */ }
          }
        });
        proxyRes.on("end", () => {
          if (config.logRest) {
            console.log(`[STREAM_PROXY_BYTES] total=${bytes}`);
          }
        });
        proxyRes.on("error", () => {
          try {
            clientRes.end();
          } catch {
            // ignore
          }
        });
        proxyRes.pipe(clientRes);
      }
    );

    proxyReq.setTimeout(30_000, () => {
      proxyReq.destroy(new Error("upstream timeout"));
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy stream error", err);
      if (!clientRes.headersSent) {
        clientRes.status(502);
      }
      clientRes.end();
    });

    proxyReq.end();
  } catch (err) {
    console.error("Proxy stream setup error", err);
    if (!clientRes.headersSent) {
      clientRes.status(502);
    }
    clientRes.end();
  }
}
