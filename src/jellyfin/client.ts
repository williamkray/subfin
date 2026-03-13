/**
 * Jellyfin API client wrapper. Uses @jellyfin/sdk with an existing access token
 * (obtained via web UI linking). All methods are for a single user context.
 */
import { randomUUID } from "node:crypto";
import axios from "axios";
import { Jellyfin } from "@jellyfin/sdk/lib/jellyfin.js";
import { getAuthorizationHeader } from "@jellyfin/sdk/lib/utils/authentication.js";
import { getClientIp } from "../request-context.js";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api/library-api.js";
import { getUserViewsApi } from "@jellyfin/sdk/lib/utils/api/user-views-api.js";
import { getItemsApi } from "@jellyfin/sdk/lib/utils/api/items-api.js";
import { getPlaylistsApi } from "@jellyfin/sdk/lib/utils/api/playlists-api.js";
import { getGenresApi } from "@jellyfin/sdk/lib/utils/api/genres-api.js";
import { getQuickConnectApi } from "@jellyfin/sdk/lib/utils/api/quick-connect-api.js";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api/user-api.js";
import { getPlaystateApi } from "@jellyfin/sdk/lib/utils/api/playstate-api.js";
import { getSessionApi } from "@jellyfin/sdk/lib/utils/api/session-api.js";
import { InstantMixApiFactory } from "@jellyfin/sdk/lib/generated-client/api/instant-mix-api.js";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models/base-item-dto.js";
import { BaseItemKind } from "@jellyfin/sdk/lib/generated-client/models/base-item-kind.js";
import { CollectionType } from "@jellyfin/sdk/lib/generated-client/models/collection-type.js";
import { ItemFields } from "@jellyfin/sdk/lib/generated-client/models/item-fields.js";
import { MediaType } from "@jellyfin/sdk/lib/generated-client/models/media-type.js";
import { config } from "../config.js";

const { jellyfin: jf } = config;

/**
 * Context for Jellyfin API calls. Either a plain access token (legacy / no device) or an object
 * with token, optional per-device identity, and optional Jellyfin base URL for multi-tenant.
 */
export type JellyfinContext =
  | string
  | { accessToken: string; jellyfinBaseUrl?: string; userId?: string; deviceId?: string; deviceName?: string };

/** Resolve the Jellyfin base URL from context. Falls back to config singleton for backward compat. */
function resolveBaseUrl(ctx: JellyfinContext): string {
  if (typeof ctx === "string") return jf.baseUrl;
  return ctx.jellyfinBaseUrl ?? jf.baseUrl;
}

function normalizeContext(ctx: JellyfinContext): {
  accessToken: string;
  jellyfinBaseUrl: string;
  device?: { id: string; name: string };
} {
  if (typeof ctx === "string") {
    return { accessToken: ctx, jellyfinBaseUrl: jf.baseUrl };
  }
  const { accessToken, jellyfinBaseUrl, deviceId, deviceName } = ctx;
  const device =
    deviceId && deviceName ? { id: deviceId, name: deviceName } : undefined;
  return { accessToken, jellyfinBaseUrl: jellyfinBaseUrl ?? jf.baseUrl, device };
}

/**
 * Lightweight in-memory caches for operations that would otherwise perform
 * repeated network or client setup work on hot paths.
 */
type AllowedMusicFolderCacheKey = string;

interface AllowedMusicFolderCacheEntry {
  ids: string[];
  expiresAt: number;
}

type JellyfinApiCacheKey = string;
type JellyfinApiInstance = ReturnType<Jellyfin["createApi"]>;

interface JellyfinApiCacheEntry {
  api: JellyfinApiInstance;
  expiresAt: number;
}

const allowedMusicFolderCache = new Map<AllowedMusicFolderCacheKey, AllowedMusicFolderCacheEntry>();
const jellyfinApiCache = new Map<JellyfinApiCacheKey, JellyfinApiCacheEntry>();

/** Default TTLs for in-memory caches, in milliseconds. */
const ALLOWED_MUSIC_FOLDER_TTL_MS = 5 * 60 * 1000;
const JELLYFIN_API_CACHE_TTL_MS = 5 * 60 * 1000;

function makeAllowedMusicFolderCacheKey(jellyfinBaseUrl: string, accessToken: string, userId: string): AllowedMusicFolderCacheKey {
  // Include URL to scope cache per Jellyfin server in multi-tenant deployments.
  return `${jellyfinBaseUrl}:${userId}:${accessToken}`;
}

function makeJellyfinApiCacheKey(jellyfinBaseUrl: string, accessToken: string, deviceId?: string): JellyfinApiCacheKey {
  const base = accessToken || "__no_token__";
  const urlPart = jellyfinBaseUrl || jf.baseUrl;
  return deviceId ? `${urlPart}:${base}:${deviceId}` : `${urlPart}:${base}`;
}

function createJellyfinApi(jellyfinBaseUrl: string, accessToken: string, device?: { id: string; name: string }) {
  const now = Date.now();
  const key = makeJellyfinApiCacheKey(jellyfinBaseUrl, accessToken, device?.id);
  const cached = jellyfinApiCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.api;
  }

  const deviceInfo = device
    ? { id: device.id, name: device.name }
    : { id: jf.deviceId, name: jf.deviceName };
  const jellyfin = new Jellyfin({
    clientInfo: {
      name: jf.clientName,
      version: "0.1.0",
    },
    deviceInfo,
  });
  const axiosInstance = axios.create();
  axiosInstance.interceptors.request.use((config) => {
    const clientIp = getClientIp();
    if (clientIp) {
      (config.headers as Record<string, string>)["X-Forwarded-For"] = clientIp;
    }
    return config;
  });
  const api = jellyfin.createApi(jellyfinBaseUrl || jf.baseUrl, accessToken, axiosInstance);
  jellyfinApiCache.set(key, {
    api,
    expiresAt: now + JELLYFIN_API_CACHE_TTL_MS,
  });
  return api;
}

/** Get API instance for the given context (cached per URL + token + device). */
function getApi(ctx: JellyfinContext): JellyfinApiInstance {
  const { accessToken, jellyfinBaseUrl, device } = normalizeContext(ctx);
  return createJellyfinApi(jellyfinBaseUrl, accessToken, device);
}

/** Device ID to use in URLs (e.g. stream/download); from context when present, else config. */
function getDeviceIdForUrl(ctx: JellyfinContext): string {
  const { device } = normalizeContext(ctx);
  return device ? device.id : jf.deviceId;
}

/** Build the Jellyfin Authorization header for a given access token and optional device. */
export function buildJellyfinAuthHeader(
  accessToken: string,
  device?: { id: string; name: string }
): string {
  const deviceInfo = device
    ? { id: device.id, name: device.name }
    : { id: jf.deviceId, name: jf.deviceName };
  return getAuthorizationHeader(
    { name: jf.clientName, version: "0.1.0" },
    deviceInfo,
    accessToken
  );
}

/** True if value looks like a Jellyfin view ID (32 hex chars, no dashes). */
function isJellyfinViewId(value: string): boolean {
  return /^[0-9a-fA-F]{32}$/.test(value.trim());
}

/** Get music libraries (folders) for a user. Uses UserViews (works for non-admin users); Library/MediaFolders returns 403 for non-admins. */
export async function getMusicLibraries(
  ctx: JellyfinContext,
  userId: string
): Promise<{ id: string; name: string }[]> {
  const api = getApi(ctx);
  const viewsApi = getUserViewsApi(api);
  const response = await viewsApi.getUserViews({ userId });
  const data = response.data;
  const folders = data?.Items ?? [];
  const music = folders.filter(
    (f: BaseItemDto) => f.CollectionType === CollectionType.Music
  );
  return music.map((m: BaseItemDto) => ({ id: m.Id!, name: m.Name ?? "Music" }));
}

/** Get allowed music folder IDs for a user. Optionally filtered by allowedIds (from per-user DB settings).
 * Returns null when no restriction (all libraries). Caches resolved IDs per (server, user). */
export async function getAllowedMusicFolderIds(
  ctx: JellyfinContext,
  userId: string,
  allowedIds?: string[] | null
): Promise<string[] | null> {
  // No restriction when no allowedIds configured.
  if (!allowedIds || allowedIds.length === 0) return null;
  const { accessToken, jellyfinBaseUrl } = normalizeContext(ctx);
  const now = Date.now();
  // Cache key includes the allowedIds hash to invalidate when settings change.
  const settingsKey = allowedIds.join(",");
  const key = makeAllowedMusicFolderCacheKey(jellyfinBaseUrl, accessToken, userId) + ":" + settingsKey;
  const cached = allowedMusicFolderCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.ids;
  }
  const allFolders = await getMusicLibraries(ctx, userId);
  // Filter by allowedIds (supports both IDs and names).
  const filtered = allFolders.filter((f) =>
    allowedIds.some((v) => {
      const t = v.trim();
      if (isJellyfinViewId(t)) return f.id === t;
      return f.name.toLowerCase().trim() === t.toLowerCase();
    })
  );
  const ids = filtered.map((f) => f.id);
  allowedMusicFolderCache.set(key, {
    ids,
    expiresAt: now + ALLOWED_MUSIC_FOLDER_TTL_MS,
  });
  return ids.length > 0 ? ids : null;
}


/** Get artists (MusicArtist). Optionally filter by parentId (library). */
export async function getArtists(
  ctx: JellyfinContext,
  parentId?: string
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicArtist],
    recursive: true,
    parentId: parentId || undefined,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
  });
  return response.data?.Items ?? [];
}

/** Get a single artist by id. */
export async function getArtist(
  ctx: JellyfinContext,
  id: string
): Promise<BaseItemDto | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    if (config.logRest) {
      console.log("[JF] getArtist request ids=%j", [id]);
    }
    const response = await itemsApi.getItems({
      ids: [id],
      includeItemTypes: [BaseItemKind.MusicArtist],
    });
    const item = response.data?.Items?.[0];
    if (config.logRest) {
      console.log(
        "[JF] getArtist response found=%s id=%s name=%s",
        !!item,
        item?.Id ?? "",
        item?.Name ?? ""
      );
    }
    return item ?? null;
  } catch (err) {
    if (config.logRest) {
      console.error("[JF] getArtist error", err);
    }
    return null;
  }
}

/** Get artist with Overview (biography) and ProviderIds (e.g. MusicBrainz) for getArtistInfo. */
export async function getArtistWithInfo(
  ctx: JellyfinContext,
  id: string
): Promise<BaseItemDto | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    const response = await itemsApi.getItems({
      ids: [id],
      includeItemTypes: [BaseItemKind.MusicArtist],
      fields: [ItemFields.Overview, ItemFields.ProviderIds],
    });
    return response.data?.Items?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Get similar artists from Jellyfin (Artists/{id}/Similar). Returns MusicArtist items. */
export async function getSimilarArtists(
  ctx: JellyfinContext,
  userId: string,
  artistId: string,
  limit: number
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const libApi = getLibraryApi(api);
  try {
    const response = await libApi.getSimilarArtists({
      itemId: artistId,
      userId,
      limit,
    });
    const items = response.data?.Items ?? [];
    return items.filter((i: BaseItemDto) => i.Type === "MusicArtist") as BaseItemDto[];
  } catch {
    return [];
  }
}

/** Get albums for an artist. Prefer explicit artist/albumArtist filters over parentId so it works across different library layouts. Optionally scope to a single music library (parentId). */
export async function getAlbumsByArtist(
  ctx: JellyfinContext,
  artistId: string,
  musicFolderId?: string
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  if (config.logRest) {
    console.log("[JF] getAlbumsByArtist request artistId=%s musicFolderId=%s", artistId, musicFolderId ?? "");
  }
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicAlbum],
    recursive: true,
    // Filter by artist/albumArtist so we find albums even when they are not direct children
    // of the artist item in the library hierarchy.
    artistIds: [artistId],
    albumArtistIds: [artistId],
    parentId: musicFolderId || undefined,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
  });
  const items = response.data?.Items ?? [];
  if (config.logRest) {
    console.log("[JF] getAlbumsByArtist response count=%d", items.length);
  }
  return items;
}

/** Derive recently played albums from recently played tracks (Jellyfin sets DatePlayed on Audio, not on albums). */
async function getRecentAlbumsFromTracks(
  ctx: JellyfinContext,
  opts: { userId: string; musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const { userId, musicFolderId, size = 50, offset = 0 } = opts;
  const targetAlbums = size;
  const buffer = 10;
  const maxAlbums = targetAlbums + buffer;
  const seen = new Set<string>();
  const albumIds: string[] = [];
  const batchSize = 50;
  const maxBatches = 3; // up to 150 tracks total

  for (let batchIndex = 0; batchIndex < maxBatches && albumIds.length < maxAlbums; batchIndex++) {
    const tracks = await getRecentlyPlayedTracks(ctx, {
      userId,
      musicFolderId,
      limit: batchSize,
      offset: batchIndex * batchSize,
    });
    if (tracks.length === 0) break;
    for (const t of tracks) {
      const albumId = (t as { AlbumId?: string }).AlbumId ?? t.ParentId;
      if (albumId && !seen.has(albumId)) {
        seen.add(albumId);
        albumIds.push(albumId);
        if (albumIds.length >= maxAlbums) break;
      }
    }
    if (tracks.length < batchSize) {
      // Fewer tracks than requested means we've reached the end of the history.
      break;
    }
  }
  const pageIds = albumIds.slice(offset, offset + size);
  if (pageIds.length === 0) return [];

  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  // Jellyfin limits URI length; chunk ids to avoid 414 Request URI Too Long when many albums.
  const allItems: BaseItemDto[] = [];
  const chunkSize = 50;
  for (let i = 0; i < pageIds.length; i += chunkSize) {
    const chunk = pageIds.slice(i, i + chunkSize);
    const response = await itemsApi.getItems({
      ids: chunk,
      includeItemTypes: [BaseItemKind.MusicAlbum],
      enableUserData: true as any,
    } as any);
    allItems.push(...(response.data?.Items ?? []));
  }
  const byId = new Map<string, BaseItemDto>();
  for (const a of allItems) if (a.Id) byId.set(a.Id, a);
  return pageIds.map((id) => byId.get(id)).filter((a): a is BaseItemDto => a != null);
}

/** Get most played tracks (Audio) for the user. Used to derive "most played" albums. */
async function getMostPlayedTracks(
  ctx: JellyfinContext,
  opts: { userId: string; musicFolderId?: string; limit?: number }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { userId, musicFolderId, limit = 150 } = opts;
  const response = await itemsApi.getItems({
    userId,
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["PlayCount"],
    sortOrder: ["Descending"],
    limit,
    startIndex: 0,
    enableUserData: true as any,
  } as any);
  return response.data?.Items ?? [];
}

/** Derive most played albums from most played tracks (aggregate per-album play counts). */
async function getFrequentAlbumsFromTracks(
  ctx: JellyfinContext,
  opts: { userId: string; musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const { userId, musicFolderId, size = 50, offset = 0 } = opts;
  const tracks = await getMostPlayedTracks(ctx, {
    userId,
    musicFolderId,
    limit: 150,
  });

  const albumTotals = new Map<string, { total: number }>();
  for (const t of tracks) {
    const albumId = (t as { AlbumId?: string }).AlbumId ?? t.ParentId;
    if (!albumId) continue;
    const playCount =
      (t as { UserData?: { PlayCount?: number } }).UserData?.PlayCount ??
      (t as { PlayCount?: number }).PlayCount ??
      0;
    const current = albumTotals.get(albumId);
    if (current) {
      current.total += playCount;
    } else {
      albumTotals.set(albumId, { total: playCount });
    }
  }

  const sortedAlbumIds = Array.from(albumTotals.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([id]) => id);

  const pageIds = sortedAlbumIds.slice(offset, offset + size);
  if (pageIds.length === 0) return [];

  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  // Chunk ids to avoid very long query strings when many albums are in the page.
  const allItems: BaseItemDto[] = [];
  const chunkSize = 50;
  for (let i = 0; i < pageIds.length; i += chunkSize) {
    const chunk = pageIds.slice(i, i + chunkSize);
    const response = await itemsApi.getItems({
      ids: chunk,
      includeItemTypes: [BaseItemKind.MusicAlbum],
      enableUserData: true as any,
    } as any);
    allItems.push(...(response.data?.Items ?? []));
  }
  const items = allItems;
  const byId = new Map<string, BaseItemDto>();
  for (const a of items) if (a.Id) byId.set(a.Id, a);
  return pageIds.map((id) => byId.get(id)).filter((a): a is BaseItemDto => a != null);
}

/** Generic album list for a library (used for Subsonic getAlbumList). */
export async function getAlbumsForLibrary(
  ctx: JellyfinContext,
  opts: {
    userId?: string;
    musicFolderId?: string;
    type?: string;
    size?: number;
    offset?: number;
    genre?: string;
    fromYear?: number;
    toYear?: number;
  }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { userId, musicFolderId, type, size, offset, genre, fromYear, toYear } = opts;
  const requestedSize = size ?? 40;

  // Map Subsonic album list types to Jellyfin sort options.
  let sortBy: string[] = [];
  let sortOrder: ("Ascending" | "Descending")[] = [];
  let enableUserData = false;

  const typeLower = (type ?? "").toLowerCase();

  // Recently played: Jellyfin updates DatePlayed on tracks (Audio), not on MusicAlbum.
  // Derive recent albums from recently played tracks so the list matches scrobble history.
  // userId is required so Jellyfin returns that user's DatePlayed (required for correct sort).
  if (typeLower === "recent" && opts.userId) {
    const effectiveSize = Math.min(requestedSize, 100);
    return getRecentAlbumsFromTracks(ctx, {
      userId: opts.userId,
      musicFolderId,
      size: effectiveSize,
      offset: offset ?? 0,
    });
  }

  // Most played: album-level PlayCount can be unreliable; derive most played albums
  // from per-track play counts. userId required for user-specific PlayCount.
  if (typeLower === "frequent" && opts.userId) {
    const effectiveSize = Math.min(requestedSize, 100);
    return getFrequentAlbumsFromTracks(ctx, {
      userId: opts.userId,
      musicFolderId,
      size: effectiveSize,
      offset: offset ?? 0,
    });
  }

  // Highest rated: Subfin maps Subsonic rating to Jellyfin Likes (like/unlike).
  // "Highest" = albums the user has liked or favorited (IsFavoriteOrLikes).
  if (typeLower === "highest" && opts.userId) {
    const { accessToken, device } = normalizeContext(ctx);
    const api: any = getApi(ctx);
    const authHeader = buildJellyfinAuthHeader(accessToken, device);
    const base = resolveBaseUrl(ctx).replace(/\/$/, "");
    const url = new URL(`${base}/Users/${opts.userId}/Items`);
    url.searchParams.set("IncludeItemTypes", BaseItemKind.MusicAlbum);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("Filters", "IsFavoriteOrLikes");
    url.searchParams.set("SortBy", "SortName");
    url.searchParams.set("SortOrder", "Ascending");
    url.searchParams.set("Limit", String(requestedSize));
    url.searchParams.set("StartIndex", String(offset ?? 0));
    if (musicFolderId) url.searchParams.set("ParentId", musicFolderId);
    if (genre) url.searchParams.set("Genres", genre);
    const response = await api.axiosInstance.get(url.toString(), {
      headers: { Authorization: authHeader },
    });
    return (response.data?.Items as BaseItemDto[] | undefined) ?? [];
  }

  switch (typeLower) {
    case "newest":
      sortBy = ["DateCreated"];
      sortOrder = ["Descending"];
      break;
    case "starred":
      sortBy = ["SortName"];
      sortOrder = ["Ascending"];
      break;
    case "alphabeticalbyname":
    case "alphabeticalbyartist":
      sortBy = ["SortName"];
      sortOrder = ["Ascending"];
      break;
    case "byyear":
      sortBy = ["ProductionYear", "SortName"];
      sortOrder = ["Ascending", "Ascending"];
      break;
    case "random":
    default:
      sortBy = ["Random"];
      sortOrder = ["Ascending"];
      break;
  }

  let isFavorite: boolean | undefined;
  if ((type ?? "").toLowerCase() === "starred") {
    isFavorite = true;
  }

  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicAlbum],
    recursive: true,
    parentId: musicFolderId || undefined,
    genres: genre ? [genre] : undefined,
    years:
      fromYear != null && toYear != null
        ? Array.from(
            { length: Math.min(toYear - fromYear + 1, 100) },
            (_, i) => fromYear + i
          )
        : undefined,
    sortBy,
    sortOrder,
    limit: size ?? 50,
    startIndex: offset ?? 0,
    ...(enableUserData ? { enableUserData: true as any } : {}),
    ...(isFavorite !== undefined ? { isFavorite } : {}),
  } as any);
  return response.data?.Items ?? [];
}

/** Get the newest album's DateCreated (if any) for a library. Used as a coarse "last modified" signal for derived caches. */
export async function getNewestAlbumDateCreated(
  ctx: JellyfinContext,
  opts: { musicFolderId?: string }
): Promise<string | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { musicFolderId } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicAlbum],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["DateCreated"],
    sortOrder: ["Descending"],
    limit: 1,
    startIndex: 0,
  });
  const item = response.data?.Items?.[0];
  return (item as { DateCreated?: string } | undefined)?.DateCreated ?? null;
}

/** Get a single album by id. */
export async function getAlbum(
  ctx: JellyfinContext,
  id: string
): Promise<BaseItemDto | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    if (config.logRest) {
      console.log("[JF] getAlbum request ids=%j", [id]);
    }
    const response = await itemsApi.getItems({
      ids: [id],
      includeItemTypes: [BaseItemKind.MusicAlbum],
    });
    const item = response.data?.Items?.[0];
    if (config.logRest) {
      console.log(
        "[JF] getAlbum response found=%s id=%s name=%s parentId=%s",
        !!item,
        item?.Id ?? "",
        item?.Name ?? "",
        item?.ParentId ?? ""
      );
    }
    return item ?? null;
  } catch (err) {
    if (config.logRest) {
      console.error("[JF] getAlbum error", err);
    }
    return null;
  }
}

/** Get songs (tracks) for an album (parentId = album id). */
export async function getSongsByAlbum(
  ctx: JellyfinContext,
  albumId: string
): Promise<BaseItemDto[]> {
  if (!albumId || albumId === "null" || albumId === "undefined") {
    return [];
  }
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    const response = await itemsApi.getItems({
      parentId: albumId,
      includeItemTypes: [BaseItemKind.Audio],
      recursive: false,
      sortBy: ["ParentIndexNumber", "IndexNumber"],
      sortOrder: ["Ascending", "Ascending"],
    });
    return response.data?.Items ?? [];
  } catch {
    return [];
  }
}

/** Get top songs for a given artist name using Jellyfin play counts. */
export async function getTopSongsForArtist(
  ctx: JellyfinContext,
  artistName: string,
  count: number
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);

  // First, resolve the artist to a Jellyfin MusicArtist item.
  const artistSearch = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicArtist],
    recursive: true,
    searchTerm: artistName,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: 10,
  });
  const artists: BaseItemDto[] = artistSearch.data?.Items ?? [];
  if (artists.length === 0) return [];

  // Prefer an exact name match (case-insensitive); fall back to the first result.
  const lower = artistName.toLowerCase();
  const exact =
    artists.find((a) => (a.Name ?? "").toLowerCase() === lower) ??
    artists.find((a) => (a.SortName ?? "").toLowerCase() === lower) ??
    artists[0];
  const artistId = exact.Id;
  if (!artistId) return [];

  const songsResp = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    artistIds: [artistId],
    sortBy: ["PlayCount"],
    sortOrder: ["Descending"],
    limit: count,
    enableUserData: true as any,
  } as any);
  return songsResp.data?.Items ?? [];
}

/** Get recently played tracks (Audio) for the user. Used to derive "recently played albums"
 * because Jellyfin updates DatePlayed on tracks, not on album entities.
 * Requires userId so Jellyfin returns that user's play state (DatePlayed). */
export async function getRecentlyPlayedTracks(
  ctx: JellyfinContext,
  opts: {
    userId: string;
    musicFolderId?: string;
    limit?: number;
    offset?: number;
  }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { userId, musicFolderId, limit = 150, offset = 0 } = opts;
  const response = await itemsApi.getItems({
    userId,
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["DatePlayed"],
    sortOrder: ["Descending"],
    limit,
    startIndex: offset,
    enableUserData: true as any,
  } as any);
  return response.data?.Items ?? [];
}

/** Get random songs from the library (optionally scoped to a music folder). */
export async function getRandomSongs(
  ctx: JellyfinContext,
  opts: {
    musicFolderId?: string;
    size?: number;
    offset?: number;
    genre?: string;
  }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { musicFolderId, size, offset, genre } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    genres: genre ? [genre] : undefined,
    sortBy: ["Random"],
    sortOrder: ["Ascending"],
    limit: size ?? 50,
    startIndex: offset ?? 0,
  });
  return response.data?.Items ?? [];
}

interface JellyfinGenreSummary {
  name: string;
  songCount: number;
  albumCount: number;
}

/** Aggregate genres from audio items in the library. */
export async function getGenres(
  ctx: JellyfinContext,
  opts: { musicFolderId?: string }
): Promise<JellyfinGenreSummary[]> {
  const api = getApi(ctx);
  const genresApi = getGenresApi(api);
  const { musicFolderId } = opts;
  const response = await genresApi.getGenres({
    parentId: musicFolderId || undefined,
    // A reasonable upper bound; Jellyfin will cap as needed.
    limit: 500,
  });
  const items: BaseItemDto[] = response.data?.Items ?? [];

  return (items ?? []).map((g: any) => ({
    name: g.Name as string,
    songCount: (g.SongCount as number) ?? 0,
    albumCount: (g.AlbumCount as number) ?? 0,
  }));
}

/** Now playing entry from Jellyfin sessions. */
export interface JellyfinNowPlayingEntry {
  item: BaseItemDto;
  username: string;
  minutesAgo: number;
  playerId: string;
  playerName: string;
}

/** Get current now-playing audio items for a user from Jellyfin sessions. */
export async function getNowPlayingForUser(
  ctx: JellyfinContext,
  userId: string
): Promise<JellyfinNowPlayingEntry[]> {
  const api = getApi(ctx);
  const sessionApi = getSessionApi(api);
  const response = await sessionApi.getSessions({
    controllableByUserId: userId,
  } as any);
  const sessions: any[] = response.data ?? [];
  const now = Date.now();

  const entries: JellyfinNowPlayingEntry[] = [];
  for (const s of sessions) {
    const item = s.NowPlayingItem as BaseItemDto | undefined;
    if (!item) continue;
    // Only consider audio now-playing items.
    if ((item.MediaType as string | undefined) !== "Audio") continue;
    const userName = (s.UserName as string | undefined) ?? "";
    const playerId = (s.Id as string | undefined) ?? "";
    const playerName = (s.Client as string | undefined) ?? "";
    const lastActivity = Date.parse((s.LastActivityDate as string | undefined) ?? "") || now;
    const minutesAgo = Math.max(0, Math.round((now - lastActivity) / 60000));
    entries.push({
      item,
      username: userName,
      minutesAgo,
      playerId,
      playerName,
    });
  }
  return entries;
}

/** Report playback start for an audio item so Jellyfin can show it in Now Playing. */
export async function reportPlaybackStart(
  ctx: JellyfinContext,
  userId: string,
  itemId: string
): Promise<void> {
  const api = getApi(ctx);
  const playstateApi = getPlaystateApi(api);
  try {
    await playstateApi.reportPlaybackStart({
      playbackStartInfo: {
        ItemId: itemId,
        UserId: userId,
        CanSeek: true,
      } as any,
    } as any);
  } catch {
    // Non-fatal: logging is handled by callers if needed.
  }
}

/** Report playback progress so Jellyfin knows an item is actively playing. */
export async function reportPlaybackProgress(
  ctx: JellyfinContext,
  userId: string,
  itemId: string,
  positionMs?: number
): Promise<void> {
  const api = getApi(ctx);
  const playstateApi = getPlaystateApi(api);
  try {
    await playstateApi.reportPlaybackProgress({
      playbackProgressInfo: {
        ItemId: itemId,
        UserId: userId,
        PositionTicks:
          positionMs !== undefined ? Math.max(0, Math.floor(positionMs * 10_000)) : undefined,
        IsPaused: false,
      } as any,
    } as any);
  } catch {
    // Non-fatal.
  }
}

/** Report playback stopped so Jellyfin can finalize play state. */
export async function reportPlaybackStopped(
  ctx: JellyfinContext,
  userId: string,
  itemId: string,
  positionMs?: number
): Promise<void> {
  const api = getApi(ctx);
  const playstateApi = getPlaystateApi(api);
  try {
    await playstateApi.reportPlaybackStopped({
      playbackStopInfo: {
        ItemId: itemId,
        UserId: userId,
        PositionTicks:
          positionMs !== undefined ? Math.max(0, Math.floor(positionMs * 10_000)) : undefined,
        Failed: false,
      } as any,
    } as any);
  } catch {
    // Non-fatal.
  }
}

/** Get songs filtered by genre. */
export async function getSongsByGenre(
  ctx: JellyfinContext,
  genre: string,
  opts: { musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { musicFolderId, size, offset } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    genres: [genre],
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: size ?? 50,
    startIndex: offset ?? 0,
  });
  return response.data?.Items ?? [];
}

/** Get favorited items (songs only for now) for the current user. */
export async function getFavoriteSongs(
  ctx: JellyfinContext,
  opts: { musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { musicFolderId, size, offset } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    isFavorite: true as any,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: size ?? 200,
    startIndex: offset ?? 0,
  } as any);
  return response.data?.Items ?? [];
}

/** Get favorited albums for the current user. */
export async function getFavoriteAlbums(
  ctx: JellyfinContext,
  opts: { musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { musicFolderId, size, offset } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicAlbum],
    recursive: true,
    parentId: musicFolderId || undefined,
    isFavorite: true as any,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: size ?? 200,
    startIndex: offset ?? 0,
  } as any);
  return response.data?.Items ?? [];
}

/** Get favorited artists (MusicArtist) for the current user. */
export async function getFavoriteArtists(
  ctx: JellyfinContext,
  opts: { musicFolderId?: string; size?: number; offset?: number }
): Promise<BaseItemDto[]> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const size = opts.size ?? 200;
  const offset = opts.offset ?? 0;
  const musicFolderId = opts.musicFolderId || undefined;

  // Prefer explicit userId when available so we can hit /Users/{userId}/Items with Filters=IsFavorite,
  // which is how Jellyfin exposes user-specific favorite artists.
  const userId = typeof ctx === "string" ? undefined : ctx.userId;
  const authHeader = buildJellyfinAuthHeader(accessToken, device);

  if (userId) {
    const base = resolveBaseUrl(ctx).replace(/\/$/, "");
    const url = new URL(`${base}/Users/${userId}/Items`);
    url.searchParams.set("IncludeItemTypes", BaseItemKind.MusicArtist);
    url.searchParams.set("Recursive", "true");
    url.searchParams.set("Limit", String(size));
    url.searchParams.set("StartIndex", String(offset));
    url.searchParams.set("Filters", "IsFavorite");
    if (musicFolderId) url.searchParams.set("ParentId", musicFolderId);
    const response = await api.axiosInstance.get(url.toString(), {
      headers: { Authorization: authHeader },
    });
    return (response.data?.Items as BaseItemDto[] | undefined) ?? [];
  }

  // Fallback: legacy ItemsApi path without explicit user id. This may not see user-specific
  // favorites in all Jellyfin setups but keeps behavior for older contexts.
  const itemsApi = getItemsApi(api);
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicArtist],
    recursive: true,
    parentId: musicFolderId || undefined,
    isFavorite: true as any,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: size,
    startIndex: offset,
  } as any);
  return response.data?.Items ?? [];
}

/** Mark an item as favorite for the given user. */
export async function markFavorite(
  ctx: JellyfinContext,
  userId: string,
  itemId: string
): Promise<void> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const url = api.getUri(`/Users/${userId}/FavoriteItems/${itemId}`);
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  await api.axiosInstance.post(
    url,
    {},
    {
      headers: {
        Authorization: authHeader,
      },
    }
  );
}

/** Remove favorite flag from an item for the given user. */
export async function unmarkFavorite(
  ctx: JellyfinContext,
  userId: string,
  itemId: string
): Promise<void> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const url = api.getUri(`/Users/${userId}/FavoriteItems/${itemId}`);
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  await api.axiosInstance.delete(url, {
    headers: {
      Authorization: authHeader,
    },
  });
}

/** Update "like" rating for an item (maps Subsonic rating to Jellyfin likes). */
export async function setUserLikeForItem(
  ctx: JellyfinContext,
  userId: string,
  itemId: string,
  likes: boolean | null
): Promise<void> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  if (likes === null) {
    // Clear rating by deleting it.
    const url = api.getUri(`/Users/${userId}/Items/${itemId}/Rating`);
    await api.axiosInstance.delete(url, {
      headers: {
        Authorization: authHeader,
      },
    });
  } else {
    const url = api.getUri(`/Users/${userId}/Items/${itemId}/Rating`, {
      Likes: likes,
    });
    await api.axiosInstance.post(
      url,
      {},
      {
        headers: {
          Authorization: authHeader,
        },
      }
    );
  }
}

/** Search artists by name using Jellyfin's searchTerm. */
export async function searchArtists(
  ctx: JellyfinContext,
  query: string,
  opts: { size?: number; offset?: number; musicFolderId?: string }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { size, offset, musicFolderId } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicArtist],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    searchTerm: query,
    limit: size ?? 20,
    startIndex: offset ?? 0,
  });
  return response.data?.Items ?? [];
}

/** Search albums by name using Jellyfin's searchTerm. */
export async function searchAlbums(
  ctx: JellyfinContext,
  query: string,
  opts: { size?: number; offset?: number; musicFolderId?: string }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { size, offset, musicFolderId } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicAlbum],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    searchTerm: query,
    limit: size ?? 20,
    startIndex: offset ?? 0,
  });
  return response.data?.Items ?? [];
}

/** Search songs by title/artist/album using Jellyfin's searchTerm. */
export async function searchSongs(
  ctx: JellyfinContext,
  query: string,
  opts: { size?: number; offset?: number; musicFolderId?: string }
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const { size, offset, musicFolderId } = opts;
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    parentId: musicFolderId || undefined,
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    searchTerm: query,
    limit: size ?? 50,
    startIndex: offset ?? 0,
  });
  return response.data?.Items ?? [];
}

/**
 * Resolve songs by artist name and track title when full-text search returns nothing.
 * Finds artist by name, then lists that artist's tracks and filters by title (exact or contains).
 * Used as a fallback in getLyrics when searchSongs(artist + " " + title) returns 0 results.
 */
export async function resolveSongsByArtistAndTitle(
  ctx: JellyfinContext,
  artist: string,
  title: string,
  opts: { limit?: number } = {}
): Promise<BaseItemDto[]> {
  if (!artist?.trim() && !title?.trim()) return [];
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const limit = opts.limit ?? 50;

  // 1) Resolve artist name to a MusicArtist item
  const artistSearch = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.MusicArtist],
    recursive: true,
    searchTerm: artist.trim(),
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: 10,
  });
  const artists: BaseItemDto[] = artistSearch.data?.Items ?? [];
  if (artists.length === 0) return [];

  const artistLower = artist.trim().toLowerCase();
  const exactArtist =
    artists.find((a) => (a.Name ?? "").toLowerCase() === artistLower) ??
    artists.find((a) => (a.SortName ?? "").toLowerCase() === artistLower) ??
    artists[0];
  const artistId = exactArtist.Id;
  if (!artistId) return [];

  // 2) Get audio items for that artist
  const songsResp = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Audio],
    recursive: true,
    artistIds: [artistId],
    sortBy: ["SortName"],
    sortOrder: ["Ascending"],
    limit: Math.max(limit, 100),
  } as any);
  const songs: BaseItemDto[] = songsResp.data?.Items ?? [];
  if (songs.length === 0) return [];

  // 3) Filter by title (case-insensitive; exact match first, then contains)
  const titleNorm = title.trim().toLowerCase();
  if (!titleNorm) return songs.slice(0, limit);

  const exact = songs.filter(
    (s) => (s.Name ?? "").toLowerCase() === titleNorm || (s.SortName ?? "").toLowerCase() === titleNorm
  );
  if (exact.length > 0) return exact.slice(0, limit);
  const contains = songs.filter(
    (s) =>
      (s.Name ?? "").toLowerCase().includes(titleNorm) || (s.SortName ?? "").toLowerCase().includes(titleNorm)
  );
  return contains.slice(0, limit);
}

interface JellyfinPlaylistSummary {
  id: string;
  name: string;
  owner: string;
  comment: string;
  songCount: number;
  created: string | null;
  changed: string | null;
  duration: number | null;
}

/** List playlists visible to the given user. */
export async function getPlaylists(
  ctx: JellyfinContext,
  userId: string
): Promise<JellyfinPlaylistSummary[]> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  const response = await itemsApi.getItems({
    includeItemTypes: [BaseItemKind.Playlist],
    recursive: true,
    parentId: undefined,
  });
  const items: BaseItemDto[] = response.data?.Items ?? [];
  return items.map((p) => ({
    id: p.Id!,
    name: p.Name ?? "",
    owner: (p as any).UserId ?? "",
    comment: "",
    songCount: (p as any).ChildCount ?? 0,
    created: p.DateCreated ?? null,
    changed: (p as any).DateLastModified ?? null,
    duration: (p as any).RunTimeTicks ?? null,
  }));
}

/** Get items in a Jellyfin playlist as audio tracks. */
export async function getPlaylistItems(
  ctx: JellyfinContext,
  playlistId: string,
  userId: string
): Promise<BaseItemDto[]> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const url = api.getUri(`/Playlists/${playlistId}/Items`, { UserId: userId });
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  const response = await api.axiosInstance.get(url, {
    headers: {
      Authorization: authHeader,
    },
  });
  const items: BaseItemDto[] = response.data?.Items ?? [];
  return items;
}

/** Create a new playlist. Returns the new playlist id. */
export async function createPlaylist(
  ctx: JellyfinContext,
  userId: string,
  name: string,
  itemIds?: string[],
  isPublic?: boolean
): Promise<string> {
  const api = getApi(ctx);
  const playlistsApi = getPlaylistsApi(api);
  const raw = itemIds ?? [];
  const ids = raw.filter(
    (id): id is string =>
      typeof id === "string" &&
      id.trim() !== "" &&
      id !== "[object Object]"
  );
  const result = await playlistsApi.createPlaylist({
    createPlaylistDto: {
      Name: name,
      UserId: userId,
      MediaType: MediaType.Audio,
      IsPublic: isPublic ?? false,
      Ids: ids.length > 0 ? ids : undefined,
    },
  });
  const id = (result.data as { Id?: string })?.Id;
  if (!id) throw new Error("Create playlist did not return an id");
  return id;
}

/** Add items to an existing playlist. */
export async function addItemsToPlaylist(
  ctx: JellyfinContext,
  playlistId: string,
  userId: string,
  itemIds: string[]
): Promise<void> {
  const ids = itemIds.filter(
    (id): id is string =>
      typeof id === "string" &&
      id.trim() !== "" &&
      id !== "[object Object]"
  );
  if (ids.length === 0) return;
  const api = getApi(ctx);
  const playlistsApi = getPlaylistsApi(api);
  await playlistsApi.addItemToPlaylist({
    playlistId,
    ids,
    userId,
  });
}

/** Remove items from a playlist by their item ids (as returned in getPlaylistItems). */
export async function removeItemsFromPlaylist(
  ctx: JellyfinContext,
  playlistId: string,
  entryIds: string[]
): Promise<void> {
  if (entryIds.length === 0) return;
  const api = getApi(ctx);
  const playlistsApi = getPlaylistsApi(api);
  await playlistsApi.removeItemFromPlaylist({
    playlistId,
    entryIds,
  });
}

/** Update playlist name or visibility. */
export async function updatePlaylistMetadata(
  ctx: JellyfinContext,
  playlistId: string,
  dto: { Name?: string; IsPublic?: boolean }
): Promise<void> {
  const api = getApi(ctx);
  const playlistsApi = getPlaylistsApi(api);
  await playlistsApi.updatePlaylist({
    playlistId,
    updatePlaylistDto: dto as any,
  });
}

/** Delete a playlist (must be owned by the user). */
export async function deletePlaylist(
  ctx: JellyfinContext,
  playlistId: string
): Promise<void> {
  const { accessToken, device } = normalizeContext(ctx);
  const api: any = getApi(ctx);
  const url = api.getUri(`/Items/${playlistId}`);
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  await api.axiosInstance.delete(url, {
    headers: { Authorization: authHeader },
  });
}

/** Get a single song (audio item) by id. */
export async function getSong(
  ctx: JellyfinContext,
  id: string
): Promise<BaseItemDto | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    const response = await itemsApi.getItems({
      ids: [id],
      includeItemTypes: [BaseItemKind.Audio],
    });
    return response.data?.Items?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Get any single item by id (artist, album, song, etc.) so we can detect type for instant mix. */
export async function getItemById(
  ctx: JellyfinContext,
  id: string
): Promise<BaseItemDto | null> {
  const api = getApi(ctx);
  const itemsApi = getItemsApi(api);
  try {
    const response = await itemsApi.getItems({
      ids: [id],
      limit: 1,
    });
    return response.data?.Items?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Get similar songs using Jellyfin's instant mix (recommendations). Uses Artists/Album/Item endpoints so plugins (e.g. AudioMuse-AI) get the right context. When id has no prefix, resolves type so artist ids still hit /Artists/{id}/InstantMix. */
export async function getSimilarSongs(
  ctx: JellyfinContext,
  userId: string,
  id: string,
  count: number
): Promise<BaseItemDto[]> {
  const api = getApi(ctx);
  const instantMixApi = InstantMixApiFactory(
    api.configuration,
    api.basePath,
    api.axiosInstance
  );
  let isArtist = /^ar-/i.test(id);
  let isAlbum = /^al-/i.test(id);
  const cleanId = id.replace(/^(ar-|al-|pl-)/i, "");
  const limit = Math.min(Math.max(1, count), 100);
  const opts = { userId, limit };

  // When client sends raw id (e.g. Tempus artist Radio without ar- prefix), resolve so we call the right endpoint (Artists/Album/Item) for AudioMuse-style plugins
  if (!isArtist && !isAlbum) {
    const item = await getItemById(ctx, cleanId);
    const type = (item as { Type?: string } | null)?.Type;
    if (type === "MusicArtist") {
      isArtist = true;
      if (config.logRest) console.log("[INSTANT_MIX] resolved id=" + cleanId + " to artist, using Artists/InstantMix");
    } else if (type === "MusicAlbum") {
      isAlbum = true;
      if (config.logRest) console.log("[INSTANT_MIX] resolved id=" + cleanId + " to album, using Albums/InstantMix");
    }
  }

  const parseItems = (response: { data?: Record<string, unknown> }): BaseItemDto[] => {
    const data = response.data;
    const raw = (data?.Items ?? data?.items) as BaseItemDto[] | undefined;
    const items = Array.isArray(raw) ? raw : [];
    if (items.length === 0 && data && config.logRest) {
      const arr = data.Items ?? data.items;
      console.warn("[INSTANT_MIX] response keys:", Object.keys(data), "Items length:", Array.isArray(arr) ? arr.length : arr);
    }
    return items.filter((i: BaseItemDto) => i.Type === "Audio") as BaseItemDto[];
  };

  try {
    let response: { data?: Record<string, unknown> };
    if (isArtist) {
      try {
        response = await instantMixApi.getInstantMixFromArtists({ itemId: cleanId, ...opts });
      } catch (artistErr: unknown) {
        if (config.logRest) {
          console.warn("[INSTANT_MIX] getInstantMixFromArtists failed:", (artistErr as Error)?.message ?? artistErr);
        }
        response = await instantMixApi.getInstantMixFromItem({ itemId: cleanId, ...opts });
      }
      let items = parseItems(response);
      if (items.length === 0) {
        if (config.logRest) {
          console.warn("[INSTANT_MIX] artist id=" + cleanId + " returned 0 items, trying getInstantMixFromItem");
        }
        response = await instantMixApi.getInstantMixFromItem({ itemId: cleanId, ...opts });
        items = parseItems(response);
      }
      if (config.logRest) {
        console.log("[INSTANT_MIX] artist id=" + cleanId + " returned " + items.length + " songs");
      }
      return items;
    }
    if (isAlbum) {
      response = await instantMixApi.getInstantMixFromAlbum({ itemId: cleanId, ...opts });
    } else {
      response = await instantMixApi.getInstantMixFromItem({ itemId: cleanId, ...opts });
    }
    const items = parseItems(response);
    if (config.logRest) {
      const kind = isAlbum ? "album" : "item";
      console.log("[INSTANT_MIX] " + kind + " id=" + cleanId + " returned " + items.length + " songs");
    }
    return items;
  } catch (err: unknown) {
    if (config.logRest) {
      console.warn("[INSTANT_MIX] failed:", (err as Error)?.message ?? err);
    }
    return [];
  }
}

/** Raw lyric line from Jellyfin (we parse multiple possible shapes). start is always in milliseconds for OpenSubsonic. */
export interface JellyfinLyricLine {
  text?: string;
  /** Start time in milliseconds (OpenSubsonic convention). Converted from Jellyfin ticks (100-ns) when needed. */
  start?: number | null;
}

interface LyricsCacheEntry {
  value: string;
  lines?: JellyfinLyricLine[];
  expiresAt: number;
}

const lyricsCache = new Map<string, LyricsCacheEntry>();
const LYRICS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Jellyfin often returns Start in .NET ticks (100-nanosecond units). 1 ms = 10,000 ticks. OpenSubsonic uses milliseconds. */
function lyricStartToMs(raw: number | null | undefined): number | null {
  if (raw == null || typeof raw !== "number") return null;
  // Values > ~10 min in ms (600000) are almost certainly ticks. 1 ms = 10000 ticks.
  if (raw > 600000) return Math.round(raw / 10000);
  return raw;
}

/** Normalise a single lyric line from various Jellyfin shapes into { text, startMs }. */
function parseLyricLine(l: Record<string, unknown>): { text: string; startMs: number | null } {
  const t = ((l.Text ?? l.Value ?? l.Line ?? l.text ?? l.value ?? "") as string).trim();
  const raw =
    (l.Start as number | undefined) ??
    (l.StartTicks as number | undefined) ??
    (l.StartTimeTicks as number | undefined) ??
    (l.start as number | undefined);
  return { text: t, startMs: lyricStartToMs(raw ?? null) };
}

/** Get lyrics for an audio item. Uses direct GET to /Audio/{id}/Lyrics so we control URL and parsing. Returns lines with start in milliseconds for live/synced lyrics. */
export async function getLyricsForItem(
  ctx: JellyfinContext,
  itemId: string
): Promise<{ value: string; lines?: JellyfinLyricLine[] } | null> {
  const now = Date.now();
  const cacheKey = itemId;
  const cached = lyricsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { value: cached.value, lines: cached.lines };
  }
  const { accessToken, device } = normalizeContext(ctx);
  const base = resolveBaseUrl(ctx).replace(/\/$/, "");
  const url = `${base}/Audio/${itemId}/Lyrics`;
  const authHeader = buildJellyfinAuthHeader(accessToken, device);
  const api: any = getApi(ctx);
  try {
    const response = await api.axiosInstance.get(url, {
      headers: { Authorization: authHeader },
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      if (config.logRest) {
        console.warn("[LYRICS] GET", url, "status=", response.status, "body=", JSON.stringify(response.data).slice(0, 200));
      }
      return null;
    }
    const data = response.data as Record<string, unknown>;
    if (!data) return null;
    if (config.logRest && (data.Lyrics === undefined || (Array.isArray(data.Lyrics) && data.Lyrics.length === 0))) {
      console.warn("[LYRICS] GET", url, "keys=", Object.keys(data), "Lyrics=", Array.isArray(data.Lyrics) ? "[]" : data.Lyrics);
    }

    const lines: JellyfinLyricLine[] = [];
    let plainText = "";

    // Primary: Jellyfin LyricDto { Lyrics?: LyricLine[] }; LyricLine: { Text?, Start? } (Start may be ticks)
    const lyricsArray = data.Lyrics as Record<string, unknown>[] | undefined;
    if (Array.isArray(lyricsArray) && lyricsArray.length > 0) {
      for (const l of lyricsArray) {
        const { text: t, startMs } = parseLyricLine(l as Record<string, unknown>);
        if (t) {
          lines.push({ text: t, start: startMs });
          plainText += (plainText ? "\n" : "") + t;
        }
      }
      if (plainText) {
        lyricsCache.set(cacheKey, {
          value: plainText,
          lines,
          expiresAt: now + LYRICS_CACHE_TTL_MS,
        });
        return { value: plainText, lines };
      }
    }

    // Cues array (some Jellyfin responses use Lyrics.Cues[] with Start/Text)
    const cues = (data.Cues as Record<string, unknown>[] | undefined) ?? (data.Lyrics as { Cues?: Record<string, unknown>[] })?.Cues;
    if (Array.isArray(cues) && cues.length > 0) {
      for (const c of cues) {
        const { text: t, startMs } = parseLyricLine(c as Record<string, unknown>);
        if (t) {
          lines.push({ text: t, start: startMs });
          plainText += (plainText ? "\n" : "") + t;
        }
      }
      if (plainText) {
        lyricsCache.set(cacheKey, {
          value: plainText,
          lines,
          expiresAt: now + LYRICS_CACHE_TTL_MS,
        });
        return { value: plainText, lines };
      }
    }

    // Alternative: single string (no timestamps)
    if (typeof data.Lyrics === "string" && data.Lyrics.trim()) {
      const value = data.Lyrics.trim();
      lyricsCache.set(cacheKey, {
        value,
        lines: [],
        expiresAt: now + LYRICS_CACHE_TTL_MS,
      });
      return { value, lines: [] };
    }

    // Nested Metadata.Lyrics or Lines (array of { Text } or { value }) — no Start in these shapes
    const meta = data.Metadata as Record<string, unknown> | undefined;
    const nested = (meta?.Lyrics ?? data.Lines) as Record<string, unknown>[] | undefined;
    if (Array.isArray(nested)) {
      for (const l of nested) {
        const t = ((l.Text ?? l.value ?? l.Value) as string ?? "").trim();
        if (t) plainText += (plainText ? "\n" : "") + t;
      }
      if (plainText) {
        lyricsCache.set(cacheKey, {
          value: plainText,
          lines: [],
          expiresAt: now + LYRICS_CACHE_TTL_MS,
        });
        return { value: plainText, lines: [] };
      }
    }

    if (plainText) {
      lyricsCache.set(cacheKey, {
        value: plainText,
        lines: [],
        expiresAt: now + LYRICS_CACHE_TTL_MS,
      });
      return { value: plainText, lines: [] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Subsonic format names that need transcoding via /Audio/{id}/stream.{container}. Universal only reliably does MP3. */
const TRANSCODE_FORMATS = new Set(["opus", "aac", "m4a", "webma", "wav"]);

/** Get stream URL for an audio item (used when proxying to client). Uses universal for MP3; uses stream-by-container for Opus/AAC/etc. so Jellyfin actually transcodes. */
export function getStreamUrl(
  ctx: JellyfinContext,
  userId: string,
  itemId: string,
  maxBitRateKbps?: number,
  format?: string
): string {
  const { accessToken } = normalizeContext(ctx);
  const deviceId = getDeviceIdForUrl(ctx);
  const base = resolveBaseUrl(ctx).replace(/\/$/, "");
  const normalized = (format ?? "").toLowerCase().trim();
  const wantTranscode = normalized && normalized !== "raw" && TRANSCODE_FORMATS.has(normalized);
  const audioBitRateBps = maxBitRateKbps && maxBitRateKbps > 0 ? maxBitRateKbps * 1000 : 320000;

  if (wantTranscode) {
    // /Audio/{id}/stream.{container} with audioCodec + audioBitRate so Jellyfin transcodes (universal returns 0 bytes for Opus).
    const container = normalized === "webma" ? "webm" : normalized;
    const url = new URL(`${base}/Audio/${itemId}/stream.${container}`);
    url.searchParams.set("UserId", userId);
    url.searchParams.set("DeviceId", deviceId);
    url.searchParams.set("audioCodec", container === "m4a" ? "aac" : container);
    url.searchParams.set("audioBitRate", String(audioBitRateBps));
    url.searchParams.set("ApiKey", accessToken);
    return url.toString();
  }

  // MP3 or raw/unspecified: use universal endpoint (reliable for MP3).
  const url = new URL(`${base}/Audio/${itemId}/universal`);
  url.searchParams.set("UserId", userId);
  url.searchParams.set("DeviceId", deviceId);
  url.searchParams.set("Container", "mp3");
  url.searchParams.set("AudioCodec", "mp3");
  url.searchParams.set("MaxStreamingBitrate", String(audioBitRateBps));
  url.searchParams.set("ApiKey", accessToken);
  return url.toString();
}

/**
 * Get download URL for an audio item (used when proxying to client).
 * Uses Jellyfin's audio stream endpoint and requests the original file (`Static=true`).
 */
export function getDownloadUrl(
  ctx: JellyfinContext,
  userId: string,
  itemId: string
): string {
  const { accessToken } = normalizeContext(ctx);
  const deviceId = getDeviceIdForUrl(ctx);
  const base = resolveBaseUrl(ctx).replace(/\/$/, "");
  const url = new URL(`${base}/Audio/${itemId}/stream`);
  url.searchParams.set("UserId", userId);
  url.searchParams.set("DeviceId", deviceId);
  // Ask Jellyfin to serve the original file when possible instead of a transcoded stream.
  url.searchParams.set("static", "true");
  url.searchParams.set("ApiKey", accessToken);
  return url.toString();
}

/** Get cover/image URL for an item (used when proxying to client). */
export function getImageUrl(
  ctx: JellyfinContext,
  itemId: string,
  imageType = "Primary",
  size?: number
): string {
  const { accessToken } = normalizeContext(ctx);
  const base = resolveBaseUrl(ctx).replace(/\/$/, "");
  const url = new URL(`${base}/Items/${itemId}/Images/${imageType}`);
  if (size && size > 0) {
    url.searchParams.set("maxHeight", String(size));
    url.searchParams.set("maxWidth", String(size));
  }
  url.searchParams.set("ApiKey", accessToken);
  return url.toString();
}

/** Get avatar URL for a given Jellyfin user (used when proxying to client). */
export function getUserAvatarUrl(
  ctx: JellyfinContext,
  userId: string,
  size?: number
): string {
  const { accessToken } = normalizeContext(ctx);
  const base = resolveBaseUrl(ctx).replace(/\/$/, "");
  const url = new URL(`${base}/Users/${userId}/Images/Primary`);
  if (size && size > 0) {
    url.searchParams.set("maxHeight", String(size));
    url.searchParams.set("maxWidth", String(size));
  }
  url.searchParams.set("ApiKey", accessToken);
  return url.toString();
}

/** Check if QuickConnect is enabled on a given Jellyfin server. */
export async function getQuickConnectEnabled(jellyfinUrl?: string): Promise<boolean> {
  const api = getApi({ accessToken: "", jellyfinBaseUrl: jellyfinUrl });
  const qcApi = getQuickConnectApi(api);
  try {
    const response = await qcApi.getQuickConnectEnabled();
    return response.data ?? false;
  } catch {
    return false;
  }
}

/** Start QuickConnect: returns { secret, code, deviceId, deviceName } for user to authorize in Jellyfin.
 * Uses a unique device id per call so Jellyfin treats each QC flow as a different device (avoids token overwrite).
 * Optional deviceNameOverride: use a custom name (e.g. "Subfin Share: Summer playlist") so the device is identifiable in the Jellyfin dashboard. */
export async function initiateQuickConnect(jellyfinUrl: string, deviceNameOverride?: string): Promise<{
  secret: string;
  code: string;
  deviceId: string;
  deviceName: string;
} | null> {
  const deviceId = "subfin-qc-" + randomUUID();
  const deviceName = (deviceNameOverride?.trim() && deviceNameOverride.trim().length <= 128)
    ? deviceNameOverride.trim()
    : "Subfin QC";
  const api = getApi({ accessToken: "", jellyfinBaseUrl: jellyfinUrl, deviceId, deviceName });
  const qcApi = getQuickConnectApi(api);
  try {
    const response = await qcApi.initiateQuickConnect();
    const data = response.data;
    if (data?.Secret && data?.Code) {
      return { secret: data.Secret, code: data.Code, deviceId, deviceName };
    }
    return null;
  } catch (err: unknown) {
    if (QC_DEBUG) {
      const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.log("[QC] initiateQuickConnect error", ax.response?.status ?? ax.message, ax.response?.data ?? "");
    }
    return null;
  }
}

/** Authorize a pending Quick Connect request (requires existing token). */
export async function authorizeQuickConnect(
  code: string,
  userId: string,
  existingAccessToken: string,
  jellyfinUrl?: string
): Promise<boolean> {
  const api = getApi({ accessToken: existingAccessToken, jellyfinBaseUrl: jellyfinUrl });
  const qcApi = getQuickConnectApi(api);
  try {
    await qcApi.authorizeQuickConnect({ code, userId });
    return true;
  } catch (err: unknown) {
    if (QC_DEBUG) {
      const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.log("[QC] authorizeQuickConnect error", ax.response?.status ?? ax.message, ax.response?.data ?? "");
    }
    return false;
  }
}

const QC_DEBUG = process.env.SUBFIN_LOG_QC === "1" || process.env.SUBFIN_LOG_QC === "true";

function qcLog(msg: string, detail?: unknown): void {
  if (QC_DEBUG && detail !== undefined) {
    console.log("[QC]", msg, typeof detail === "object" ? JSON.stringify(detail) : detail);
  } else if (QC_DEBUG) {
    console.log("[QC]", msg);
  }
}

/** Use existing token to approve a QC request and get a new token (for "unique token per device" without password).
 * Flow: initiate QC → authorize with existing token → poll until authenticated → exchange for new token.
 * Returns the Jellyfin device id/name used so callers can store them and send the same device on later requests
 * (so the device appears as a distinct device in the Jellyfin dashboard).
 * Optional options.deviceName: custom name for this device in Jellyfin (e.g. "Subfin Share: My playlist"). */
export async function getNewTokenViaQuickConnect(
  jellyfinUrl: string,
  existingAccessToken: string,
  jellyfinUserId: string,
  options?: { deviceName?: string }
): Promise<{ userId: string; accessToken: string; deviceId: string; deviceName: string } | null> {
  const initiated = await initiateQuickConnect(jellyfinUrl, options?.deviceName);
  if (!initiated) {
    console.warn("[QC] Link new device (no password): Quick Connect failed at initiate.");
    return null;
  }
  qcLog("initiate ok", { code: initiated.code });
  const { secret, code, deviceId, deviceName } = initiated;
  const authorized = await authorizeQuickConnect(code, jellyfinUserId, existingAccessToken, jellyfinUrl);
  if (!authorized) {
    console.warn("[QC] Link new device (no password): Quick Connect failed at authorize (check token validity).");
    return null;
  }
  qcLog("authorize ok");
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const state = await getQuickConnectState(secret, jellyfinUrl);
    if (state.authenticated) {
      const auth = await authenticateWithQuickConnect(secret, jellyfinUrl, { id: deviceId, name: deviceName });
      if (auth) {
        qcLog("token exchange ok");
        return { ...auth, deviceId, deviceName };
      }
      console.warn("[QC] Link new device (no password): Quick Connect authenticated but token exchange failed.");
      return null;
    }
    qcLog(`poll ${i + 1}/10`, state);
  }
  console.warn("[QC] Link new device (no password): Quick Connect timed out waiting for authenticated state.");
  return null;
}

/** Poll QuickConnect state. */
export async function getQuickConnectState(secret: string, jellyfinUrl?: string): Promise<{
  authenticated: boolean;
}> {
  const api = getApi({ accessToken: "", jellyfinBaseUrl: jellyfinUrl });
  const qcApi = getQuickConnectApi(api);
  try {
    const response = await qcApi.getQuickConnectState({ secret });
    const data = response.data as { Authenticated?: boolean };
    return { authenticated: data?.Authenticated ?? false };
  } catch (err: unknown) {
    if (QC_DEBUG) {
      const ax = err as { response?: { status?: number }; message?: string };
      console.log("[QC] getQuickConnectState error", ax.response?.status ?? ax.message);
    }
    return { authenticated: false };
  }
}

/** Exchange QuickConnect secret for token (call after getQuickConnectState returns authenticated).
 * Pass the same device used at Initiate so Jellyfin ties the token to that device. */
export async function authenticateWithQuickConnect(
  secret: string,
  jellyfinUrl?: string,
  device?: { id: string; name: string }
): Promise<{ userId: string; accessToken: string } | null> {
  const api = device
    ? getApi({ accessToken: "", jellyfinBaseUrl: jellyfinUrl, deviceId: device.id, deviceName: device.name })
    : getApi({ accessToken: "", jellyfinBaseUrl: jellyfinUrl });
  const userApi = getUserApi(api);
  try {
    const response = await userApi.authenticateWithQuickConnect({
      quickConnectDto: { Secret: secret },
    });
    const data = response.data;
    const userId = data?.User?.Id;
    const accessToken = data?.AccessToken;
    if (userId && accessToken) {
      return { userId, accessToken };
    }
    return null;
  } catch (err: unknown) {
    if (QC_DEBUG) {
      const ax = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.log("[QC] authenticateWithQuickConnect error", ax.response?.status ?? ax.message, ax.response?.data ?? "");
    }
    return null;
  }
}

/** Get current user info (name) given an access token or context. */
export async function getCurrentUserName(ctxOrToken: JellyfinContext | string): Promise<string | null> {
  const api = getApi(ctxOrToken);
  const userApi = getUserApi(api);
  try {
    const response = await userApi.getCurrentUser();
    const user = response.data;
    return user?.Name ?? null;
  } catch {
    return null;
  }
}

/** Authenticate by username and password (for web UI when server supports password).
 * Uses unauthenticated API (empty token). Jellyfin 10.8 had a bug where AuthenticateByName
 * with a bad/invalid Authorization header could wipe the server's Devices table; fixed in 10.9.
 * See .local-testing/auth-and-device-investigation.md. */
export async function authenticateByName(
  jellyfinUrl: string,
  username: string,
  password: string
): Promise<{ userId: string; accessToken: string } | null> {
  return authenticateByNameWithDevice(jellyfinUrl, username, password, jf.deviceId, jf.deviceName);
}

/** Authenticate by username and password with a specific device id/name.
 * Jellyfin creates a new session (and token) per device. Use this when linking a new
 * Subfin device so each linked device has its own long-lived Jellyfin token. */
export async function authenticateByNameWithDevice(
  jellyfinUrl: string,
  username: string,
  password: string,
  deviceId: string,
  deviceName: string
): Promise<{ userId: string; accessToken: string } | null> {
  const api = getApi({
    accessToken: "",
    jellyfinBaseUrl: jellyfinUrl,
    deviceId,
    deviceName,
  });
  const userApi = getUserApi(api);
  try {
    const response = await userApi.authenticateUserByName({
      authenticateUserByName: { Username: username, Pw: password },
    });
    const data = response.data;
    const userId = data?.User?.Id;
    const accessToken = data?.AccessToken;
    if (userId && accessToken) {
      return { userId, accessToken };
    }
    return null;
  } catch (err: unknown) {
    if (config.logRest) {
      const status = err && typeof err === "object" && "response" in err && err.response && typeof (err.response as { status?: number }).status === "number"
        ? (err.response as { status: number }).status
        : null;
      const msg = status != null ? `Jellyfin AuthenticateByName failed: HTTP ${status}` : "Jellyfin AuthenticateByName failed (network or error)";
      console.log(`[REST] ${msg}`);
    }
    return null;
  }
}

/** Report that the session for the given token has ended (POST /Sessions/Logout).
 * Call this when unlinking a device so Jellyfin revokes that device's token. */
export async function reportSessionEnded(accessToken: string): Promise<void> {
  const api = getApi(accessToken);
  const sessionApi = getSessionApi(api);
  try {
    await sessionApi.reportSessionEnded();
  } catch {
    // Session may already be gone or token invalid; ignore.
  }
}
