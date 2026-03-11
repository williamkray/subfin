/** Get or build the album-derived artist index for the given effective folder ids, using derived_cache to avoid
 * repeatedly walking Jellyfin libraries. */
async function getOrBuildArtistIndex(
  auth: AuthResult,
  folderIds: string[] | null
): Promise<BaseItemDto[]> {
  const ctx = toJellyfinContext(auth);

  // Build a stable cache key from user + effective folder set.
  const folderPart =
    folderIds === null ? "all" : folderIds.length === 0 ? "none" : folderIds.slice().sort().join(",");
  const cacheKey = `artistIndex:${auth.jellyfinUserId}:${folderPart}`;
  const ttlMs = 15 * 60 * 1000; // 15 minutes

  // Cheap probe: newest album timestamp used as a coarse "library changed" signal.
  const newestPerFolder: (string | null)[] = [];
  if (folderIds === null) {
    newestPerFolder.push(await jf.getNewestAlbumDateCreated(ctx, { musicFolderId: undefined }));
  } else if (folderIds.length > 0) {
    for (const id of folderIds) {
      newestPerFolder.push(await jf.getNewestAlbumDateCreated(ctx, { musicFolderId: id }));
    }
  }
  const latestAlbumDate =
    newestPerFolder
      .filter((d): d is string => !!d)
      .sort()
      .slice(-1)[0] ?? null;

  const existing = getDerivedCache<CachedArtistIndexPayload>(cacheKey);
  if (existing && existing.value && existing.cachedAt) {
    const ageMs = Date.now() - new Date(existing.cachedAt).getTime();
    const sourceUnchanged =
      !latestAlbumDate || existing.lastSourceChangeAt === latestAlbumDate || !existing.lastSourceChangeAt;
    if (ageMs < ttlMs && sourceUnchanged) {
      return (existing.value.artists ?? []).map((a) => {
        const name = a.Name ?? "";
        return {
          Id: a.Id,
          Name: name,
          AlbumCount: a.AlbumCount ?? 0,
        } as BaseItemDto;
      });
    }
  }

  const artists = await getAlbumArtistsForFolders(auth, folderIds);
  setDerivedCache<CachedArtistIndexPayload>(
    cacheKey,
    {
      artists: artists.map((a) => ({
        Id: a.Id,
        Name: a.Name ?? "",
        AlbumCount: (a as any).AlbumCount ?? 0,
      })),
    },
    latestAlbumDate
  );
  return artists;
}
/**
 * OpenSubsonic method handlers. Each receives auth result and query params, returns Subsonic-shaped payload or throws.
 */
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models/base-item-dto.js";
import * as jf from "../jellyfin/client.js";
import { config } from "../config.js";
import {
  clearPlayQueue,
  getPlayQueue,
  savePlayQueue,
  createShare as storeCreateShare,
  getJellyfinCredentialsForLinking,
  getSharesForUser,
  updateShare as storeUpdateShare,
  deleteShare as storeDeleteShare,
  getDerivedCache,
  setDerivedCache,
} from "../store/index.js";
import { getLastFmArtistInfo } from "../lastfm/client.js";
import {
  stripSubsonicIdPrefix,
  toSubsonicArtistsIndex,
  toSubsonicArtistWithAlbums,
  toSubsonicAlbum,
  toSubsonicSong,
  resolvePrimaryArtistIdForAlbum,
  ticksToSeconds,
} from "./mappers.js";
import { toJellyfinContext, type AuthResult } from "./auth.js";

/** Resolve effective music folder id(s) for list endpoints: client param wins; else MUSIC_LIBRARY_IDS when set. Returns null = no restriction, [] = no allowed folders, [id...] = use these. */
async function getEffectiveMusicFolderIds(
  auth: AuthResult,
  clientMusicFolderId?: string
): Promise<string[] | null> {
  const trimmed = clientMusicFolderId?.trim();
  if (trimmed) return [trimmed];
  return jf.getAllowedMusicFolderIds(toJellyfinContext(auth), auth.jellyfinUserId);
}

/** Normalize artist name for deduplication/lookup: lowercase + strip spaces and common punctuation. */
function canonicalArtistKey(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s._/*'"-]+/g, "");
}

/** Build a de-duplicated list of album artists for the given music folders using album-level primary artist ids. */
async function getAlbumArtistsForFolders(
  auth: AuthResult,
  folderIds: string[] | null
): Promise<BaseItemDto[]> {
  // When there are no allowed folders, return an empty list immediately.
  if (Array.isArray(folderIds) && folderIds.length === 0) {
    return [];
  }

  const ctx = toJellyfinContext(auth);
  const byArtist = new Map<string, { Id: string; Name: string; AlbumCount: number }>();
  const pageSize = 200;

  const accumulateFromFolder = async (musicFolderId: string | undefined) => {
    let offset = 0;
    for (;;) {
      const page = await jf.getAlbumsForLibrary(ctx, {
        userId: auth.jellyfinUserId,
        musicFolderId,
        type: "alphabeticalByArtist",
        size: pageSize,
        offset,
      });
      if (page.length === 0) break;
      for (const album of page) {
        const primaryArtistId = resolvePrimaryArtistIdForAlbum(album);
        if (!primaryArtistId) continue;
        const artistName =
          (album as Record<string, string | undefined>).AlbumArtist ??
          (album.Artists && album.Artists[0]) ??
          "";
        if (!artistName) continue;
        const key = canonicalArtistKey(artistName);
        if (!key) continue;
        const existing = byArtist.get(key);
        if (existing) {
          existing.AlbumCount += 1;
        } else {
          byArtist.set(key, {
            Id: primaryArtistId,
            Name: artistName,
            AlbumCount: 1,
          });
        }
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  };

  if (folderIds === null) {
    await accumulateFromFolder(undefined);
  } else {
    for (const id of folderIds) {
      await accumulateFromFolder(id);
    }
  }

  return Array.from(byArtist.values()).map(
    (a) =>
      ({
        Id: a.Id,
        Name: a.Name,
        AlbumCount: a.AlbumCount,
      } as BaseItemDto)
  );
}

interface CachedArtistIndexPayload {
  artists: { Id?: string; Name?: string; AlbumCount?: number }[];
}

export async function handlePing(): Promise<Record<string, unknown>> {
  return {};
}

export async function handleGetLicense(): Promise<Record<string, unknown>> {
  return {
    license: {
      valid: true,
    },
  };
}

/** OpenSubsonic: advertise supported extensions (static list). */
export async function handleGetOpenSubsonicExtensions(): Promise<Record<string, unknown>> {
  return {
    // Per OpenSubsonic spec, this must be an array of { name, versions }
    // directly under subsonic-response.openSubsonicExtensions.
    openSubsonicExtensions: [
      {
        name: "songLyrics",
        versions: [1],
      },
    ],
  };
}

export async function handleGetMusicFolders(auth: AuthResult): Promise<Record<string, unknown>> {
  const folders = await jf.getMusicLibraries(toJellyfinContext(auth), auth.jellyfinUserId);
  return {
    musicFolders: {
      musicFolder: folders.map((f) => ({ id: f.id, name: f.name })),
    },
  };
}

export async function handleGetArtists(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  const artists = await getOrBuildArtistIndex(auth, folderIds);
  return {
    artists: toSubsonicArtistsIndex(artists),
  };
}

/** Subsonic getIndexes: similar to getArtists but wrapped in <indexes>. */
export async function handleGetIndexes(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  const artists = await getAlbumArtistsForFolders(auth, folderIds);
  const idx = toSubsonicArtistsIndex(artists);
  return {
    indexes: {
      lastModified: Date.now(),
      ignoredArticles: idx.ignoredArticles,
      index: idx.index,
    },
  };
}

export async function handleGetArtist(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const cleanId = stripSubsonicIdPrefix(id);
  if (config.logRest) {
    console.log("[ARTIST] getArtist params: id=%s cleanId=%s", id, cleanId);
  }
  const ctx = toJellyfinContext(auth);
  const folderIds = await jf.getAllowedMusicFolderIds(ctx, auth.jellyfinUserId);
  let albums: Awaited<ReturnType<typeof jf.getAlbumsByArtist>> = [];
  if (folderIds === null) {
    albums = await jf.getAlbumsByArtist(ctx, cleanId, undefined);
  } else if (folderIds.length === 0) {
    albums = [];
  } else if (folderIds.length === 1) {
    albums = await jf.getAlbumsByArtist(ctx, cleanId, folderIds[0]);
  } else {
    const results = await Promise.all(
      folderIds.map((musicFolderId) => jf.getAlbumsByArtist(ctx, cleanId, musicFolderId))
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getAlbumsByArtist>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    albums = Array.from(byId.values());
  }
  const artist = await jf.getArtist(ctx, cleanId);
  if (!artist) throw new Error("NotFound");
  const payload = {
    artist: toSubsonicArtistWithAlbums(artist, albums),
  };
  if (config.logRest) {
    console.log(
      "[ARTIST] getArtist response: artistId=%s name=%s albumCount=%d",
      artist.Id ?? "",
      artist.Name ?? "",
      albums.length
    );
  }
  return payload;
}

/** Subsonic getMusicDirectory: artist → albums, album → songs. */
export async function handleGetMusicDirectory(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) {
    throw new Error("Missing id");
  }
  const cleanId = stripSubsonicIdPrefix(id);

  // Try album first (al- prefix or raw album id).
  const album = await jf.getAlbum(toJellyfinContext(auth), cleanId);
  if (album) {
    const songs = await jf.getSongsByAlbum(toJellyfinContext(auth), cleanId);
    const artistName = album.AlbumArtist ?? album.Artists?.[0] ?? "";
    if (config.logRest) {
      console.log(
        "[MUSIC_DIRECTORY] treating id=%s as album cleanId=%s songs=%d",
        id,
        cleanId,
        songs.length
      );
    }
    return {
      musicDirectory: {
        id: album.Id,
        name: album.Name ?? "",
        parent: album.ParentId,
        child: songs.map((s) =>
          toSubsonicSong(s, album.Id ?? undefined, album.Name ?? undefined, artistName)
        ),
      },
    };
  }

  // Fallback: treat as artist (ar- prefix or raw artist id).
  const [artist, albums] = await Promise.all([
    jf.getArtist(toJellyfinContext(auth), cleanId),
    jf.getAlbumsByArtist(toJellyfinContext(auth), cleanId),
  ]);
  if (!artist) {
    throw new Error("NotFound");
  }
  const artistName = artist.Name ?? "";
  if (config.logRest) {
    console.log(
      "[MUSIC_DIRECTORY] treating id=%s as artist cleanId=%s albums=%d",
      id,
      cleanId,
      albums.length
    );
  }
  return {
    musicDirectory: {
      id: artist.Id,
      name: artistName,
      parent: artist.ParentId,
      child: albums.map((a) => ({
        id: a.Id,
        parent: artist.Id,
        title: a.Name ?? "",
        album: a.Name ?? "",
        artist: artistName,
        isDir: true,
        coverArt: a.Id ? `al-${a.Id}` : undefined,
        year: a.ProductionYear ?? undefined,
        genre: a.Genres?.[0] ?? undefined,
      })),
    },
  };
}

export async function handleGetAlbum(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  // Some clients (e.g. Castafiore) can accidentally send literal "undefined"/"null" here.
  // Treat those the same as a missing id so we return a clear Subsonic error instead of
  // resolving an arbitrary Jellyfin item like a top-level library.
  if (!id || id === "undefined" || id === "null") {
    throw new Error("Missing id");
  }
  const cleanId = stripSubsonicIdPrefix(id);
  if (config.logRest) {
    console.log("[ALBUM] getAlbum params: id=%s cleanId=%s", id, cleanId);
  }
  const [album, songs] = await Promise.all([
    jf.getAlbum(toJellyfinContext(auth), cleanId),
    jf.getSongsByAlbum(toJellyfinContext(auth), cleanId),
  ]);
  if (!album) throw new Error("NotFound");
  const subsonicAlbum = toSubsonicAlbum(album, songs, auth.jellyfinAccessToken);
  if (config.logRest) {
    console.log(
      "[ALBUM] getAlbum response: albumId=%s artist=%s artistId=%s songCount=%d",
      String(subsonicAlbum.id ?? ""),
      String(subsonicAlbum.artist ?? ""),
      String(subsonicAlbum.artistId ?? ""),
      songs.length
    );
  }
  return {
    album: subsonicAlbum,
  };
}

/** Subsonic getAlbumList: generic album lists for home screens. */
export async function handleGetAlbumList(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const type = params.type?.trim() || "random";
  const size = Number.parseInt(params.size ?? "40", 10) || 40;
  const offset = Number.parseInt(params.offset ?? "0", 10) || 0;
  const genre = params.genre?.trim() || undefined;
  const fromYear = params.fromYear ? Number.parseInt(params.fromYear, 10) : undefined;
  const toYear = params.toYear ? Number.parseInt(params.toYear, 10) : undefined;

  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  let albums: Awaited<ReturnType<typeof jf.getAlbumsForLibrary>>;
  if (folderIds === null) {
    albums = await jf.getAlbumsForLibrary(toJellyfinContext(auth), {
      userId: auth.jellyfinUserId,
      type,
      size,
      offset,
      genre,
      fromYear: type.toLowerCase() === "byyear" ? fromYear : undefined,
      toYear: type.toLowerCase() === "byyear" ? toYear : undefined,
    });
  } else if (folderIds.length === 0) {
    albums = [];
  } else if (folderIds.length === 1) {
    albums = await jf.getAlbumsForLibrary(toJellyfinContext(auth), {
      userId: auth.jellyfinUserId,
      musicFolderId: folderIds[0],
      type,
      size,
      offset,
      genre,
      fromYear: type.toLowerCase() === "byyear" ? fromYear : undefined,
      toYear: type.toLowerCase() === "byyear" ? toYear : undefined,
    });
  } else {
    const needed = offset + size;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.getAlbumsForLibrary(toJellyfinContext(auth), {
          userId: auth.jellyfinUserId,
          musicFolderId,
          type,
          size: needed,
          offset: 0,
          genre,
          fromYear: type.toLowerCase() === "byyear" ? fromYear : undefined,
          toYear: type.toLowerCase() === "byyear" ? toYear : undefined,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getAlbumsForLibrary>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    const merged = Array.from(byId.values());
    const typeLower = type.toLowerCase();
    if (typeLower === "newest") {
      merged.sort((a, b) => (b.DateCreated ?? "").localeCompare(a.DateCreated ?? ""));
    } else if (typeLower === "recent") {
      const lastPlayed = (x: typeof merged[0]) =>
        (x as { UserData?: { LastPlayedDate?: string }; DateLastPlayed?: string }).UserData
          ?.LastPlayedDate ??
        (x as { DateLastPlayed?: string }).DateLastPlayed ??
        "";
      merged.sort((a, b) => lastPlayed(b).localeCompare(lastPlayed(a)));
    } else if (typeLower === "frequent") {
      const playCount = (x: typeof merged[0]) => (x as { PlayCount?: number }).PlayCount ?? 0;
      merged.sort((a, b) => playCount(b) - playCount(a));
    } else if (
      typeLower === "starred" ||
      typeLower === "highest" ||
      typeLower === "alphabeticalbyname" ||
      typeLower === "alphabeticalbyartist"
    ) {
      merged.sort((a, b) => (a.SortName ?? "").localeCompare(b.SortName ?? ""));
    } else if (typeLower === "byyear") {
      merged.sort(
        (a, b) =>
          (a.ProductionYear ?? 0) - (b.ProductionYear ?? 0) ||
          (a.SortName ?? "").localeCompare(b.SortName ?? "")
      );
    }
    albums = merged.slice(offset, offset + size);
  }

  return {
    albumList: {
      album: albums.map((a) => {
        const primaryArtistId = resolvePrimaryArtistIdForAlbum(a);
        return {
          id: a.Id,
          name: a.Name ?? "",
          artist: a.AlbumArtist ?? a.Artists?.[0] ?? "",
          artistId: primaryArtistId ? `ar-${primaryArtistId}` : undefined,
          coverArt: a.Id ? `al-${a.Id}` : undefined,
          songCount: a.ChildCount ?? 0,
          // Duration and playCount are part of the OpenSubsonic album list model and
          // many clients treat them as always-present. Prefer Jellyfin's RunTimeTicks /
          // PlayCount when available, otherwise fall back to 0.
          duration: (() => {
            const ticks = (a as { RunTimeTicks?: number }).RunTimeTicks;
            return ticks != null ? ticksToSeconds(ticks) : 0;
          })(),
          playCount: (a as { PlayCount?: number }).PlayCount ?? 0,
          year: a.ProductionYear ?? undefined,
          created: a.DateCreated ?? new Date(0).toISOString(),
          genre: (a as { Genres?: string[] }).Genres?.[0] ?? undefined,
        };
      }),
    },
  };
}

/** Subsonic getAlbumList2: delegate to getAlbumList (ID3 vs folder not distinguished yet). */
export async function handleGetAlbumList2(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  // Reuse the same data as getAlbumList; expose it as both albumList and albumList2
  // so JSON clients expecting albumList2 work, and our XML serializer (which reads
  // albumList) continues to function unchanged.
  const base = await handleGetAlbumList(auth, params);
  const albumList = (base as any).albumList ?? {};
  return {
    albumList,
    albumList2: albumList,
  };
}

/** Minimal getUser: return the current Subsonic user with no special roles. */
export async function handleGetUser(auth: AuthResult): Promise<Record<string, unknown>> {
  return {
    user: {
      username: auth.subsonicUsername,
      email: "",
    },
  };
}

/** Minimal getUsers: just return the current user in a list. */
export async function handleGetUsers(auth: AuthResult): Promise<Record<string, unknown>> {
  return {
    users: {
      user: [
        {
          username: auth.subsonicUsername,
          email: "",
        },
      ],
    },
  };
}

/** getPlaylists: list playlists visible to the current user. */
export async function handleGetPlaylists(
  auth: AuthResult
): Promise<Record<string, unknown>> {
  const pls = await jf.getPlaylists(toJellyfinContext(auth), auth.jellyfinUserId);
  return {
    playlists: {
      playlist: pls.map((p) => ({
        id: p.id,
        name: p.name,
        owner: p.owner || auth.subsonicUsername,
        comment: p.comment,
        songCount: p.songCount,
        public: false,
        created: p.created ?? p.changed ?? new Date(0).toISOString(),
        changed: p.changed,
        duration: p.duration != null ? Math.floor(p.duration / 10_000_000) : 0,
        // OpenSubsonic: playlist-level cover art id.
        // Navic and other clients use this with getCoverArt to show playlist images.
        coverArt: p.id ? `pl-${p.id}` : undefined,
      })),
    },
  };
}

/** getPlaylist: list entries in a playlist as Subsonic songs. */
export async function handleGetPlaylist(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) {
    throw new Error("Missing id");
  }

  const ctx = toJellyfinContext(auth);
  const items = await jf.getPlaylistItems(ctx, id, auth.jellyfinUserId);
  const allPlaylists = await jf.getPlaylists(ctx, auth.jellyfinUserId);
  const meta = allPlaylists.find((p) => String(p.id) === id);

  const name = meta?.name ?? params.name?.trim() ?? "";
  const comment = meta?.comment ?? "";
  const songCount = meta?.songCount ?? items.length;
  const created = meta?.created ?? meta?.changed ?? new Date(0).toISOString();
  const changed = meta?.changed;
  const duration =
    meta?.duration != null ? Math.floor(meta.duration / 10_000_000) : 0;

  return {
    playlist: {
      id,
      name,
      owner: auth.subsonicUsername,
      public: false,
      comment,
      created,
      changed,
      duration,
      songCount,
      // Match getPlaylists: advertise a playlist-level coverArt id.
      coverArt: `pl-${id}`,
      entry: items.map((i) => toSubsonicSong(i)),
    },
  };
}

/** createPlaylist: create new playlist or overwrite existing (when playlistId given). */
export async function handleCreatePlaylist(
  auth: AuthResult,
  params: Record<string, string> & {
    songIds?: string[];
  }
): Promise<Record<string, unknown>> {
  const name = params.name?.trim();
  if (!name) throw new Error("Missing name");

  const songIds = params.songIds ?? [];
  const playlistId = params.playlistId?.trim();
  const isPublic = params.public?.toLowerCase() === "true";

  try {
    if (playlistId) {
      // Overwrite existing playlist: set name and replace items.
      await jf.updatePlaylistMetadata(toJellyfinContext(auth), playlistId, {
        Name: name,
        ...(params.public !== undefined && { IsPublic: isPublic }),
      });
      const current = await jf.getPlaylistItems(
        toJellyfinContext(auth),
        playlistId,
        auth.jellyfinUserId
      );
      const currentIds = current.map((i) => i.Id!).filter(Boolean);
      if (currentIds.length > 0) {
        await jf.removeItemsFromPlaylist(
          toJellyfinContext(auth),
          playlistId,
          currentIds
        );
      }
      if (songIds.length > 0) {
        await jf.addItemsToPlaylist(
          toJellyfinContext(auth),
          playlistId,
          auth.jellyfinUserId,
          songIds
        );
      }
      return { playlist: { id: playlistId, name } };
    }
    const id = await jf.createPlaylist(
      toJellyfinContext(auth),
      auth.jellyfinUserId,
      name,
      songIds.length > 0 ? songIds : undefined,
      params.public !== undefined ? isPublic : undefined
    );
    return { playlist: { id, name } };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      throw Object.assign(new Error("Not allowed to modify this playlist"), { code: 50 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("not allowed")) {
      throw Object.assign(new Error("Not allowed to modify this playlist"), { code: 50 });
    }
    throw err;
  }
}

/** updatePlaylist: rename, set public/comment, add/remove songs by index. */
export async function handleUpdatePlaylist(
  auth: AuthResult,
  params: Record<string, string> & {
    songIdsToAdd?: string[];
    songIndexesToRemove?: number[];
  }
): Promise<Record<string, unknown>> {
  const playlistId = params.playlistId?.trim();
  if (!playlistId) throw new Error("Missing playlistId");

  const name = params.name?.trim();
  const comment = params.comment?.trim();
  const isPublic = params.public?.toLowerCase() === "true";
  const songIdsToAdd = params.songIdsToAdd ?? [];
  const songIndexesToRemove = params.songIndexesToRemove ?? [];

  try {
    if (name !== undefined && name !== "") {
      await jf.updatePlaylistMetadata(toJellyfinContext(auth), playlistId, {
        Name: name,
      });
    }
    if (comment !== undefined || params.public !== undefined) {
      await jf.updatePlaylistMetadata(toJellyfinContext(auth), playlistId, {
        IsPublic: params.public !== undefined ? isPublic : undefined,
      });
    }

    const items = await jf.getPlaylistItems(
      toJellyfinContext(auth),
      playlistId,
      auth.jellyfinUserId
    );

    if (songIndexesToRemove.length > 0) {
      const indices = [...new Set(songIndexesToRemove)].sort((a, b) => b - a);
      const idsToRemove: string[] = [];
      for (const i of indices) {
        if (i >= 0 && i < items.length && items[i].Id) idsToRemove.push(items[i].Id!);
      }
      if (idsToRemove.length > 0) {
        await jf.removeItemsFromPlaylist(
          toJellyfinContext(auth),
          playlistId,
          idsToRemove
        );
      }
    }

    if (songIdsToAdd.length > 0) {
      await jf.addItemsToPlaylist(
        toJellyfinContext(auth),
        playlistId,
        auth.jellyfinUserId,
        songIdsToAdd
      );
    }

    return {};
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      throw Object.assign(new Error("Not allowed to modify this playlist"), { code: 50 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("not allowed")) {
      throw Object.assign(new Error("Not allowed to modify this playlist"), { code: 50 });
    }
    throw err;
  }
}

/** deletePlaylist: delete a playlist by id. */
export async function handleDeletePlaylist(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");

  try {
    await jf.deletePlaylist(toJellyfinContext(auth), id);
    return {};
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      throw Object.assign(new Error("Not allowed to delete this playlist"), { code: 50 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("not allowed")) {
      throw Object.assign(new Error("Not allowed to delete this playlist"), { code: 50 });
    }
    throw err;
  }
}

/** getArtistInfo: biography and similar artists from Jellyfin. id can be artist (ar-*), album, or song; we resolve to artist. */
export async function handleGetArtistInfo(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const count = Math.min(Math.max(1, Number.parseInt(params.count ?? "20", 10) || 20), 50);
  const artistId = stripSubsonicIdPrefix(id);

  // Resolve to artist id if id is album or song
  let resolvedArtistId = /^ar-/i.test(id) ? artistId : null;
  if (!resolvedArtistId) {
    const item = await jf.getItemById(toJellyfinContext(auth), artistId);
    const type = (item as { Type?: string } | null)?.Type;
    if (type === "MusicArtist") {
      resolvedArtistId = artistId;
    } else if (type === "MusicAlbum" || type === "Audio") {
      const albumArtistIds = (item as { AlbumArtistIds?: string[] })?.AlbumArtistIds;
      resolvedArtistId = Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : artistId;
    } else {
      resolvedArtistId = artistId;
    }
  }

  const [artist, similar] = await Promise.all([
    jf.getArtistWithInfo(toJellyfinContext(auth), resolvedArtistId),
    jf.getSimilarArtists(toJellyfinContext(auth), auth.jellyfinUserId, resolvedArtistId, count),
  ]);

  const baseUrl = config.subfinPublicUrl;
  const coverId = "ar-" + resolvedArtistId;
  const imageUrl = (size?: number) =>
    baseUrl ? `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverId)}${size ? `&size=${size}` : ""}` : undefined;

  const artistName = (artist as { Name?: string } | null)?.Name ?? "";
  const rawBio = (artist as { Overview?: string } | null)?.Overview?.trim() ?? "";
  const providerIds = (artist as { ProviderIds?: { MusicBrainzArtist?: string; MusicBrainz?: string } } | null)
    ?.ProviderIds;
  const jellyfinMusicBrainzId =
    providerIds?.MusicBrainzArtist ?? providerIds?.MusicBrainz ?? "";

  let biography = rawBio;
  let lastFmUrl = "";

  const lastFm = await getLastFmArtistInfo({
    name: artistName,
    musicBrainzId: jellyfinMusicBrainzId || undefined,
  });
  if (lastFm) {
    if (!biography && lastFm.biography) {
      biography = lastFm.biography;
    }
    if (lastFm.lastFmUrl) {
      lastFmUrl = lastFm.lastFmUrl;
    }
  }

  if (!biography) {
    biography = "No biography is available for this artist.";
  }

  // Normalize similar artist display names using the same album-derived artist index used by getArtists/search3,
  // so clients see consistent names (including special characters) across views. Reuse cached index where possible.
  const folderIdsForIndex = await getEffectiveMusicFolderIds(auth, undefined);
  const albumArtists = await getOrBuildArtistIndex(auth, folderIdsForIndex);
  const canonicalById = new Map<string, string>();
  const canonicalByKey = new Map<string, string>();
  for (const a of albumArtists) {
    if (a.Id && a.Name) {
      const id = String(a.Id);
      const name = a.Name;
      canonicalById.set(id, name);
      const key = canonicalArtistKey(name);
      if (key && !canonicalByKey.has(key)) {
        canonicalByKey.set(key, name);
      }
    }
  }

  return {
    artistInfo: {
      name: artistName,
      biography,
      musicBrainzId: jellyfinMusicBrainzId,
      lastFmUrl,
      smallImageUrl: imageUrl(34),
      mediumImageUrl: imageUrl(64),
      largeImageUrl: imageUrl(174) ?? imageUrl(300),
      similarArtist: similar.map((a) => ({
        id: a.Id ? "ar-" + a.Id : undefined,
        name: (() => {
          const rawName = a.Name ?? "";
          const fromId = a.Id ? canonicalById.get(a.Id) : undefined;
          if (fromId) return fromId;
          const key = canonicalArtistKey(rawName);
          const fromKey = key ? canonicalByKey.get(key) : undefined;
          return fromKey ?? rawName;
        })(),
        coverArt: a.Id ? "ar-" + a.Id : undefined,
      })),
    },
  };
}

/** getArtistInfo2: same as getArtistInfo but response key is artistInfo2 (spec). */
export async function handleGetArtistInfo2(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const res = await handleGetArtistInfo(auth, params);
  return { artistInfo2: res.artistInfo };
}

/** getAlbumInfo: album notes and artwork from Jellyfin. id can be album (al-*), or song; we resolve to album. */
export async function handleGetAlbumInfo(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const cleanId = stripSubsonicIdPrefix(id);
  const ctx = toJellyfinContext(auth);

  // Resolve to album id if id is song or other item.
  let albumId: string | null = /^al-/i.test(id) ? cleanId : null;
  if (!albumId) {
    const item = await jf.getItemById(ctx, cleanId);
    const type = (item as { Type?: string } | null)?.Type;
    if (type === "MusicAlbum") {
      albumId = cleanId;
    } else if (type === "Audio") {
      const anyItem = item as { AlbumId?: string; ParentId?: string } | null;
      albumId = anyItem?.AlbumId ?? anyItem?.ParentId ?? cleanId;
    } else {
      albumId = cleanId;
    }
  }

  const album = await jf.getAlbum(ctx, albumId);
  if (!album) throw new Error("NotFound");

  const baseUrl = config.subfinPublicUrl;
  const coverId = "al-" + (album.Id ?? albumId);
  const imageUrl = (size?: number) =>
    baseUrl ? `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverId)}${size ? `&size=${size}` : ""}` : undefined;

  const anyAlbum = album as {
    Overview?: string;
    ProviderIds?: { MusicBrainzReleaseGroup?: string; MusicBrainzAlbum?: string; MusicBrainz?: string };
  } | null;
  const notes = anyAlbum?.Overview?.trim() ?? "";
  const providerIds = anyAlbum?.ProviderIds;
  const musicBrainzId =
    providerIds?.MusicBrainzReleaseGroup ?? providerIds?.MusicBrainzAlbum ?? providerIds?.MusicBrainz ?? "";

  return {
    albumInfo: {
      notes,
      musicBrainzId,
      lastFmUrl: "",
      smallImageUrl: imageUrl(34),
      mediumImageUrl: imageUrl(64),
      largeImageUrl: imageUrl(174) ?? imageUrl(300),
    },
  };
}

/** getAlbumInfo2: ID3-based album info; for Jellyfin we treat it the same as getAlbumInfo and return albumInfo per spec. */
export async function handleGetAlbumInfo2(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  return handleGetAlbumInfo(auth, params);
}

/** getStarred / getStarred2: favorites backed by Jellyfin user favorites (artists, albums, songs). */
export async function handleGetStarred(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const size = Number.parseInt(params.size ?? "200", 10) || 200;
  const offset = Number.parseInt(params.offset ?? "0", 10) || 0;
  const musicFolderId = params.musicFolderId?.trim() || undefined;
  const ctx = toJellyfinContext(auth);
  const [artists, albums, songs] = await Promise.all([
    jf.getFavoriteArtists(ctx, { musicFolderId, size, offset }),
    jf.getFavoriteAlbums(ctx, { musicFolderId, size, offset }),
    jf.getFavoriteSongs(ctx, { musicFolderId, size, offset }),
  ]);
  if (config.logRest) {
    console.log(
      "[STARRED] getStarred favorites: artists=%d albums=%d songs=%d",
      artists.length,
      albums.length,
      songs.length
    );
  }
  return {
    starred: {
      // Artist: id, name, coverArt, albumCount (required by OpenSubsonic; safe fallbacks for Youamp/Musly).
      artist: artists.map((a) => ({
        id: a.Id ? `ar-${a.Id}` : "",
        name: a.Name ?? "",
        coverArt: a.Id ? `ar-${a.Id}` : "",
        albumCount: a.AlbumCount ?? 0,
      })),
      // Album: id, name, artist, created required by Youamp; "album" = name for clients that expect it.
      album: albums.map((a) => {
        const primaryArtistId = resolvePrimaryArtistIdForAlbum(a);
        const name = a.Name ?? "";
        return {
          id: a.Id ? `al-${a.Id}` : "",
          name,
          album: name,
          artist: a.AlbumArtist ?? a.Artists?.[0] ?? "",
          artistId: primaryArtistId ? `ar-${primaryArtistId}` : "",
          coverArt: a.Id ? `al-${a.Id}` : "",
          created: a.DateCreated ?? new Date(0).toISOString(),
          songCount: a.ChildCount ?? 0,
          year: a.ProductionYear ?? undefined,
          genre: a.Genres?.[0] ?? undefined,
        };
      }),
      // Song: toSubsonicSong already provides id, title, suffix, contentType, size and full child shape.
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

export async function handleGetStarred2(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  // Reuse getStarred data; router will shape XML as <starred2>.
  const res = await handleGetStarred(auth, params);
  return {
    starred2: (res as any).starred,
  } as Record<string, unknown>;
}

/** getRandomSongs: random audio items for home/random views. */
export async function handleGetRandomSongs(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const size = Number.parseInt(params.size ?? "50", 10) || 50;
  const offset = Number.parseInt(params.offset ?? "0", 10) || 0;
  const genre = params.genre?.trim() || undefined;

  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  let songs: Awaited<ReturnType<typeof jf.getRandomSongs>>;
  if (folderIds === null) {
    songs = await jf.getRandomSongs(toJellyfinContext(auth), { size, offset, genre });
  } else if (folderIds.length === 0) {
    songs = [];
  } else if (folderIds.length === 1) {
    songs = await jf.getRandomSongs(toJellyfinContext(auth), {
      musicFolderId: folderIds[0],
      genre,
      size,
      offset,
    });
  } else {
    const needed = offset + size;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.getRandomSongs(toJellyfinContext(auth), {
          musicFolderId,
          genre,
          size: needed,
          offset: 0,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getRandomSongs>>[number]>();
    for (const list of results) for (const s of list) if (s.Id) byId.set(s.Id, s);
    songs = Array.from(byId.values()).slice(offset, offset + size);
  }

  return {
    randomSongs: {
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

/** getGenres: aggregate genres from Jellyfin audio items. */
export async function handleGetGenres(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  try {
    const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
    let genres: Awaited<ReturnType<typeof jf.getGenres>>;
    if (folderIds === null) {
      genres = await jf.getGenres(toJellyfinContext(auth), {});
    } else if (folderIds.length === 0) {
      genres = [];
    } else if (folderIds.length === 1) {
      genres = await jf.getGenres(toJellyfinContext(auth), {
        musicFolderId: folderIds[0],
      });
    } else {
      const results = await Promise.all(
        folderIds.map((musicFolderId) =>
          jf.getGenres(toJellyfinContext(auth), { musicFolderId })
        )
      );
      const byName = new Map<string, { name: string; songCount: number; albumCount: number }>();
      for (const list of results) {
        for (const g of list) {
          const key = g.name.toLowerCase();
          const existing = byName.get(key);
          if (existing) {
            existing.songCount += g.songCount;
            existing.albumCount += g.albumCount;
          } else {
            byName.set(key, { name: g.name, songCount: g.songCount, albumCount: g.albumCount });
          }
        }
      }
      genres = Array.from(byName.values());
    }
    return {
      genres: {
        genre: genres.map((g) => ({
          value: g.name,
          songCount: g.songCount,
          albumCount: g.albumCount,
        })),
      },
    };
  } catch (err) {
    if (config.logRest) {
      console.error("[GENRES] Failed to load genres from Jellyfin", err);
    }
    // Return an empty but well-formed genres list so clients don’t crash.
    return {
      genres: {
        genre: [],
      },
    };
  }
}

/** getSongsByGenre: return songs for a given genre. */
export async function handleGetSongsByGenre(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const genre = params.genre?.trim() ?? "";
  if (!genre) {
    throw new Error("Missing genre");
  }
  const size = Number.parseInt(params.count ?? params.size ?? "50", 10) || 50;
  const offset = Number.parseInt(params.offset ?? "0", 10) || 0;

  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  let songs: Awaited<ReturnType<typeof jf.getSongsByGenre>>;
  if (folderIds === null) {
    songs = await jf.getSongsByGenre(toJellyfinContext(auth), genre, { size, offset });
  } else if (folderIds.length === 0) {
    songs = [];
  } else if (folderIds.length === 1) {
    songs = await jf.getSongsByGenre(toJellyfinContext(auth), genre, {
      musicFolderId: folderIds[0],
      size,
      offset,
    });
  } else {
    const needed = offset + size;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.getSongsByGenre(toJellyfinContext(auth), genre, {
          musicFolderId,
          size: needed,
          offset: 0,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getSongsByGenre>>[number]>();
    for (const list of results) for (const s of list) if (s.Id) byId.set(s.Id, s);
    songs = Array.from(byId.values()).slice(offset, offset + size);
  }

  return {
    songsByGenre: {
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

/** getNowPlaying: expose current Jellyfin sessions as Subsonic nowPlaying entries. */
export async function handleGetNowPlaying(
  auth: AuthResult
): Promise<Record<string, unknown>> {
  const entries = await jf.getNowPlayingForUser(toJellyfinContext(auth), auth.jellyfinUserId);
  return {
    nowPlaying: {
      entry: entries.map(({ item, username, minutesAgo, playerId, playerName }) => {
        const base = toSubsonicSong(item);
        return {
          ...base,
          username,
          minutesAgo,
          playerId,
          playerName,
        };
      }),
    },
  };
}

/** scrobble: accept playback reports and forward to Jellyfin playstate API. */
export async function handleScrobble(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const rawId = params.id?.trim();
  if (!rawId) return {};

  const id = stripSubsonicIdPrefix(rawId);
  const timeMs = params.time ? Number.parseInt(params.time, 10) || undefined : undefined;
  const submission = (params.submission ?? params.submitted ?? "").toLowerCase();
  const isSubmission =
    submission === "true" || submission === "1" || submission === "yes" || submission === "";

  if (config.logRest) {
    console.log(
      `[SCROBBLE] id=${rawId} cleanId=${id} submission=${params.submission ?? params.submitted ?? ""} isSubmission=${isSubmission} time=${params.time ?? "none"}`
    );
  }

  const ctx = toJellyfinContext(auth);
  const userId = auth.jellyfinUserId;

  if (isSubmission) {
    // End-of-track: client says this track finished. Many clients never send submission=false when
    // a queued track auto-starts, so Jellyfin never got reportPlaybackStart. Send a full
    // start → progress → stop sequence so Jellyfin records the item as played and updates
    // DatePlayed / recently played. Order and awaiting start before stop matters for Jellyfin.
    // "Now playing" in the dashboard will only update when we get this (e.g. at end of track or
    // when the client sends progress scrobbles), unless the client sends submission=false when
    // the queue advances to the next track.
    await jf.reportPlaybackStart(ctx, userId, id);
    await jf.reportPlaybackProgress(ctx, userId, id, timeMs);
    await jf.reportPlaybackStopped(ctx, userId, id, timeMs);
    if (config.logRest) console.log(`[SCROBBLE] sent start+progress+stop for ${id}`);
  } else {
    // Now playing: client says this track started (e.g. user hit next). Start session and report progress.
    await jf.reportPlaybackStart(ctx, userId, id);
    void jf.reportPlaybackProgress(ctx, userId, id, timeMs);
    if (config.logRest) console.log(`[SCROBBLE] sent start+progress (now playing) for ${id}`);
  }

  return {};
}

/** setRating: update Jellyfin user like (rating 4–5 = like, 1–2 = unlike, 3 = clear). */
export async function handleSetRating(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (id) {
    const ratingStr = params.rating ?? params.rating2 ?? "";
    const rating = Number.parseInt(ratingStr, 10);
    let likes: boolean | null = null;
    if (!Number.isNaN(rating) && rating > 0) {
      // Simple mapping: treat 4–5 as like, 1–2 as unlike, 3 as neutral (clear rating).
      if (rating >= 4) likes = true;
      else if (rating <= 2) likes = false;
      else likes = null;
    }
    await jf.setUserLikeForItem(toJellyfinContext(auth), auth.jellyfinUserId, id, likes);
  }
  return {};
}

/** star: mark item(s) as favorite in Jellyfin (id, albumId, artistId, or idList). */
export async function handleStar(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const rawIds: string[] = [];
  if (params.id) rawIds.push(params.id);
  if (params.albumId) rawIds.push(params.albumId);
  if (params.artistId) rawIds.push(params.artistId);
  if (params.idList) {
    rawIds.push(
      ...params.idList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  const uniqueIds = Array.from(new Set(rawIds));
  if (uniqueIds.length > 0) {
    await Promise.all(
      uniqueIds.map((id) =>
        jf.markFavorite(toJellyfinContext(auth), auth.jellyfinUserId, id)
      )
    );
  }
  return {};
}

/** unstar: remove favorite in Jellyfin for id, albumId, artistId, or idList. */
export async function handleUnstar(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const rawIds: string[] = [];
  if (params.id) rawIds.push(params.id);
  if (params.albumId) rawIds.push(params.albumId);
  if (params.artistId) rawIds.push(params.artistId);
  if (params.idList) {
    rawIds.push(
      ...params.idList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  const uniqueIds = Array.from(new Set(rawIds));
  if (uniqueIds.length > 0) {
    await Promise.all(
      uniqueIds.map((id) =>
        jf.unmarkFavorite(toJellyfinContext(auth), auth.jellyfinUserId, id)
      )
    );
  }
  return {};
}

/** getTopSongs: top tracks for a given artist based on Jellyfin play counts. */
export async function handleGetTopSongs(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const artistName = params.artist?.trim();
  if (!artistName) {
    throw new Error("Missing artist");
  }
  const count = Number.parseInt(params.count ?? "50", 10) || 50;
  const songs = await jf.getTopSongsForArtist(toJellyfinContext(auth), artistName, count);
  return {
    topSongs: {
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

/** getSimilarSongs: Jellyfin instant mix (recommendations) from artist, album, or song id. */
export async function handleGetSimilarSongs(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const count = Number.parseInt(params.count ?? "50", 10) || 50;
  const songs = await jf.getSimilarSongs(
    toJellyfinContext(auth),
    auth.jellyfinUserId,
    id,
    count
  );
  return {
    similarSongs: {
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

/** getSimilarSongs2: same as getSimilarSongs but response key must be similarSongs2 (spec; clients like Tempus expect it). */
export async function handleGetSimilarSongs2(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const count = Number.parseInt(params.count ?? "50", 10) || 50;
  const songs = await jf.getSimilarSongs(
    toJellyfinContext(auth),
    auth.jellyfinUserId,
    id,
    count
  );
  return {
    similarSongs2: {
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

/** getLyrics: lyrics for a song by item id or by artist+title search. When using artist+title, tries multiple search results until one has lyrics (helps clients like Tempus that don't send id). */
export async function handleGetLyrics(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  const artist = params.artist?.trim();
  const title = params.title?.trim();
  const logRest = config.logRest;
  if (logRest) {
    console.log("[LYRICS] getLyrics params: id=" + (id ? id : "(empty)") + " artist=" + (artist ?? "") + " title=" + (title ?? ""));
  }

  let itemId: string | null = null;
  let artistName = artist ?? "";
  let titleName = title ?? "";
  /** When we resolve by artist+title and find a track with lyrics in the loop, we keep the value to avoid a second fetch. */
  let valueFromSearch = "";

  if (id) {
    const song = await jf.getSong(toJellyfinContext(auth), id);
    if (song) {
      itemId = song.Id ?? null;
      artistName = song.AlbumArtist ?? song.Artists?.[0] ?? artistName;
      titleName = song.Name ?? titleName;
    }
  } else if (artist || title) {
    const query = [artist, title].filter(Boolean).join(" ");
    let songs = await jf.searchSongs(toJellyfinContext(auth), query, { size: 8 });
    // When full-text search returns 0, fall back to resolve by artist then filter by title (same track can be found)
    if (songs.length === 0 && (artist?.trim() || title?.trim())) {
      if (logRest) {
        console.log("[LYRICS] getLyrics search returned 0 results query=\"" + query + "\", trying artist+title fallback");
      }
      songs = await jf.resolveSongsByArtistAndTitle(toJellyfinContext(auth), artist ?? "", title ?? "", { limit: 8 });
      if (logRest && songs.length > 0) {
        console.log("[LYRICS] getLyrics fallback resolved " + songs.length + " candidate(s) by artist+title");
      }
    } else if (logRest && songs.length === 0) {
      console.log("[LYRICS] getLyrics search returned 0 results query=\"" + query + "\"");
    }
    // Use first result that actually has lyrics (Tempus often sends artist+title only; first hit may be a version without lyrics).
    // Probe a small number of candidates in parallel to keep latency reasonable.
    const maxCandidates = 3;
    const candidates = songs.slice(0, maxCandidates);
    if (candidates.length > 0) {
      const results = await Promise.all(
        candidates.map((song) => {
          const sid = song.Id ?? null;
          if (!sid) return Promise.resolve<{ song: typeof song; value: string } | null>(null);
          return jf
            .getLyricsForItem(toJellyfinContext(auth), sid)
            .then((lr) => (lr?.value ? { song, value: lr.value } : null))
            .catch(() => null);
        })
      );
      const hit = results.find((r) => r && r.value);
      if (hit) {
        const { song, value } = hit;
        const sid = song.Id ?? null;
        if (sid) {
          itemId = sid;
          artistName = song.AlbumArtist ?? song.Artists?.[0] ?? artistName;
          titleName = song.Name ?? titleName;
          valueFromSearch = value;
          if (logRest) {
            console.log(
              "[LYRICS] getLyrics byId=false artist+title resolved to itemId=" +
                sid +
                " via parallel candidate lyrics lookup"
            );
          }
        }
      }
    }
    if (!itemId && songs[0]) {
      const song = songs[0];
      itemId = song.Id ?? null;
      artistName = song.AlbumArtist ?? song.Artists?.[0] ?? artistName;
      titleName = song.Name ?? titleName;
      if (logRest) {
        console.log("[LYRICS] getLyrics byId=false artist+title resolved to itemId=" + (itemId ?? "") + " (no lyrics in search)");
      }
    }
  }

  if (!itemId) {
    if (logRest) {
      console.log("[LYRICS] getLyrics no itemId (id=" + (id ?? "") + " artist=" + (artist ?? "") + " title=" + (title ?? "") + ")");
    }
    return {
      lyrics: {
        artist: artistName || undefined,
        title: titleName || undefined,
        value: "",
      },
    };
  }

  const value =
    valueFromSearch ||
    (await jf.getLyricsForItem(toJellyfinContext(auth), itemId))?.value ||
    "";

  if (logRest) {
    console.log("[LYRICS] getLyrics byId=" + !!id + " itemId=" + itemId + " found=" + (value.length > 0));
  }

  return {
    lyrics: {
      artist: artistName || undefined,
      title: titleName || undefined,
      value,
    },
  };
}

/** getLyricsBySongId (OpenSubsonic): lyrics by track id, returns lyricsList with structuredLyrics. */
export async function handleGetLyricsBySongId(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (config.logRest) {
    console.log("[LYRICS] getLyricsBySongId params: id=" + (id ?? "(empty)"));
  }
  if (!id) {
    return { lyricsList: { structuredLyrics: [] } };
  }
  const itemId = stripSubsonicIdPrefix(id);
  const song = await jf.getSong(toJellyfinContext(auth), itemId);
  const displayArtist = song?.AlbumArtist ?? song?.Artists?.[0] ?? "";
  const displayTitle = song?.Name ?? "";
  const lyricsResult = await jf.getLyricsForItem(toJellyfinContext(auth), itemId);
  if (!lyricsResult?.value && (!lyricsResult?.lines || lyricsResult.lines.length === 0)) {
    return {
      lyricsList: {
        structuredLyrics: [],
      },
    };
  }
  const lines = lyricsResult.lines ?? lyricsResult.value.split("\n").filter(Boolean).map((t) => ({ text: t, start: null as number | null }));
  const synced = lines.some((l) => l.start != null);
  const line = lines.map((l) =>
    l.start != null ? { start: l.start, value: l.text ?? "" } : { value: l.text ?? "" }
  );
  return {
    lyricsList: {
      structuredLyrics: [
        {
          displayArtist: displayArtist || undefined,
          displayTitle: displayTitle || undefined,
          lang: "und",
          offset: 0,
          synced,
          line,
        },
      ],
    },
  };
}

/** search3: unified search for artists, albums, and songs. */
export async function handleSearch3(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const query = params.query?.trim() ?? "";
  if (!query) {
    return {
      searchResult3: {
        artist: [],
        album: [],
        song: [],
      },
    };
  }

  const artistCount = Number.parseInt(params.artistCount ?? "20", 10) || 20;
  const artistOffset = Number.parseInt(params.artistOffset ?? "0", 10) || 0;
  const albumCount = Number.parseInt(params.albumCount ?? "20", 10) || 20;
  const albumOffset = Number.parseInt(params.albumOffset ?? "0", 10) || 0;
  const songCount = Number.parseInt(params.songCount ?? "50", 10) || 50;
  const songOffset = Number.parseInt(params.songOffset ?? "0", 10) || 0;
  const ctx = toJellyfinContext(auth);
  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);

  async function searchArtistsScoped(): Promise<Awaited<ReturnType<typeof jf.searchArtists>>> {
    if (folderIds === null) {
      return jf.searchArtists(ctx, query, {
        size: artistCount,
        offset: artistOffset,
        musicFolderId: undefined,
      });
    }
    if (folderIds.length === 0) return [];
    if (folderIds.length === 1) {
      return jf.searchArtists(ctx, query, {
        size: artistCount,
        offset: artistOffset,
        musicFolderId: folderIds[0],
      });
    }
    const needed = artistOffset + artistCount;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.searchArtists(ctx, query, {
          size: needed,
          offset: 0,
          musicFolderId,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.searchArtists>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    return Array.from(byId.values()).slice(artistOffset, artistOffset + artistCount);
  }

  async function searchAlbumsScoped(): Promise<Awaited<ReturnType<typeof jf.searchAlbums>>> {
    if (folderIds === null) {
      return jf.searchAlbums(ctx, query, {
        size: albumCount,
        offset: albumOffset,
        musicFolderId: undefined,
      });
    }
    if (folderIds.length === 0) return [];
    if (folderIds.length === 1) {
      return jf.searchAlbums(ctx, query, {
        size: albumCount,
        offset: albumOffset,
        musicFolderId: folderIds[0],
      });
    }
    const needed = albumOffset + albumCount;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.searchAlbums(ctx, query, {
          size: needed,
          offset: 0,
          musicFolderId,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.searchAlbums>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    return Array.from(byId.values()).slice(albumOffset, albumOffset + albumCount);
  }

  async function searchSongsScoped(): Promise<Awaited<ReturnType<typeof jf.searchSongs>>> {
    if (folderIds === null) {
      return jf.searchSongs(ctx, query, {
        size: songCount,
        offset: songOffset,
        musicFolderId: undefined,
      });
    }
    if (folderIds.length === 0) return [];
    if (folderIds.length === 1) {
      return jf.searchSongs(ctx, query, {
        size: songCount,
        offset: songOffset,
        musicFolderId: folderIds[0],
      });
    }
    const needed = songOffset + songCount;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.searchSongs(ctx, query, {
          size: needed,
          offset: 0,
          musicFolderId,
        })
      )
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.searchSongs>>[number]>();
    for (const list of results) for (const s of list) if (s.Id) byId.set(s.Id, s);
    return Array.from(byId.values()).slice(songOffset, songOffset + songCount);
  }

  const [albums, songs] = await Promise.all([
    searchAlbumsScoped(),
    searchSongsScoped(),
  ]);

  // For artists, reuse the same album-derived artist index we use in getArtists so
  // names and ids are consistent (including special characters) and respect library scoping.
  const allArtists = await getOrBuildArtistIndex(auth, folderIds);
  const qLower = query.toLowerCase();
  const matchingArtists = allArtists.filter((a) => (a.Name ?? "").toLowerCase().includes(qLower));
  const artists = matchingArtists.slice(artistOffset, artistOffset + artistCount);

  return {
    searchResult3: {
      artist: artists.map((a) => ({
        id: a.Id,
        name: a.Name ?? "",
        coverArt: a.Id ? `ar-${a.Id}` : undefined,
        albumCount: (a as any).AlbumCount ?? undefined,
      })),
      album: albums.map((a) => ({
        id: a.Id,
        parent: a.ParentId,
        title: a.Name ?? "",
        album: a.Name ?? "",
        // Many clients (Navic) treat Album.name and created as required.
        name: a.Name ?? "",
        created: a.DateCreated ?? new Date(0).toISOString(),
        songCount: (a as any).ChildCount ?? 0,
        artist: a.AlbumArtist ?? a.Artists?.[0] ?? "",
        artistId: (() => {
          const albumArtistIds = (a as { AlbumArtistIds?: string[] }).AlbumArtistIds;
          const primaryArtistId =
            Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : undefined;
          return primaryArtistId ? `ar-${primaryArtistId}` : undefined;
        })(),
        isDir: true,
        coverArt: a.Id ? `al-${a.Id}` : undefined,
        year: a.ProductionYear ?? undefined,
        genre: a.Genres?.[0] ?? undefined,
      })),
      song: songs.map((s) => toSubsonicSong(s)),
    },
  };
}

export async function handleGetSong(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing id");
  const cleanId = stripSubsonicIdPrefix(id);
  const song = await jf.getSong(toJellyfinContext(auth), cleanId);
  if (!song) throw new Error("NotFound");
  return {
    song: toSubsonicSong(song),
  };
}

/** OpenSubsonic createShare: expand ids to tracks, create linked device + share row, return share with url and entry[]. */
export async function handleCreateShare(
  auth: AuthResult,
  params: { ids: string[]; description?: string; expires?: string }
): Promise<Record<string, unknown>> {
  const ids = params.ids?.filter((id) => typeof id === "string" && id.trim()) ?? [];
  if (ids.length === 0) throw new Error("At least one id is required");

  const ctx = toJellyfinContext(auth);
  const entryIds: string[] = [];
  const entryIdsFlat: string[] = [];
  const seen = new Set<string>();
  const itemsForEntry: NonNullable<Awaited<ReturnType<typeof jf.getSong>>>[] = [];

  for (const id of ids) {
    const trimmed = id.trim();
    entryIds.push(trimmed);
    if (trimmed.toLowerCase().startsWith("ar-")) {
      const artistId = stripSubsonicIdPrefix(trimmed);
      const albums = await jf.getAlbumsByArtist(ctx, artistId);
      for (const album of albums) {
        if (!album.Id) continue;
        const songs = await jf.getSongsByAlbum(ctx, album.Id);
        for (const s of songs) {
          if (s.Id && !seen.has(s.Id)) {
            seen.add(s.Id);
            entryIdsFlat.push(s.Id);
            itemsForEntry.push(s);
          }
        }
      }
    } else if (trimmed.toLowerCase().startsWith("al-")) {
      const albumId = stripSubsonicIdPrefix(trimmed);
      const album = await jf.getAlbum(ctx, albumId);
      if (!album) continue;
      const songs = await jf.getSongsByAlbum(ctx, albumId);
      for (const s of songs) {
        if (s.Id && !seen.has(s.Id)) {
          seen.add(s.Id);
          entryIdsFlat.push(s.Id);
          itemsForEntry.push(s);
        }
      }
    } else if (trimmed.toLowerCase().startsWith("pl-")) {
      const playlistId = stripSubsonicIdPrefix(trimmed);
      const items = await jf.getPlaylistItems(ctx, playlistId, auth.jellyfinUserId);
      for (const item of items) {
        if (item.Id && !seen.has(item.Id)) {
          seen.add(item.Id);
          entryIdsFlat.push(item.Id);
          itemsForEntry.push(item);
        }
      }
    } else {
      const trackId = stripSubsonicIdPrefix(trimmed);
      const song = await jf.getSong(ctx, trackId);
      if (song && song.Id && !seen.has(song.Id)) {
        seen.add(song.Id);
        entryIdsFlat.push(song.Id);
        itemsForEntry.push(song);
      } else {
        // Clients (e.g. Tempus) may send playlist id from getPlaylists without pl- prefix.
        let added = entryIdsFlat.length;
        try {
          const items = await jf.getPlaylistItems(ctx, trackId, auth.jellyfinUserId);
          for (const item of items) {
            if (item.Id && !seen.has(item.Id)) {
              seen.add(item.Id);
              entryIdsFlat.push(item.Id);
              itemsForEntry.push(item);
            }
          }
        } catch {
          // Not a playlist or not accessible.
        }
        // If still no entries from playlist, try as album (e.g. Jellyfin URL paste).
        if (entryIdsFlat.length === added) {
          const album = await jf.getAlbum(ctx, trackId);
          if (album) {
            const songs = await jf.getSongsByAlbum(ctx, trackId);
            for (const s of songs) {
              if (s.Id && !seen.has(s.Id)) {
                seen.add(s.Id);
                entryIdsFlat.push(s.Id);
                itemsForEntry.push(s);
              }
            }
          }
        }
      }
    }
  }

  if (entryIdsFlat.length === 0) throw new Error("No valid audio entries found for the given ids");

  const description = params.description?.trim() || null;
  const expiresAt = params.expires ? Number.parseInt(params.expires, 10) || null : null;
  if (expiresAt !== null && (Number.isNaN(expiresAt) || expiresAt < 0)) throw new Error("Invalid expires");

  // Use behind-the-scenes Quick Connect so the share has its own token, not tied to the requesting device.
  const creds = getJellyfinCredentialsForLinking(auth.subsonicUsername);
  if (!creds) {
    throw new Error(
      "Quick Connect required to create shares. Use the web app to link a device with Quick Connect first."
    );
  }
  const shareDeviceName =
    "Subfin Share: " + (description ? description.slice(0, 80) : "link");
  const shareAuth = await jf.getNewTokenViaQuickConnect(
    creds.jellyfinAccessToken,
    creds.jellyfinUserId,
    { deviceName: shareDeviceName }
  );
  if (!shareAuth) {
    throw new Error(
      "Quick Connect failed. Approve in Jellyfin (Settings → Quick Connect) and try again."
    );
  }

  const { shareUid, secret } = storeCreateShare(auth.subsonicUsername, shareAuth.userId, shareAuth.accessToken, {
    entryIds,
    entryIdsFlat,
    description,
    expiresAt,
    jellyfinDeviceId: shareAuth.deviceId,
    jellyfinDeviceName: shareAuth.deviceName,
  });

  const baseUrl = (config.subfinPublicUrl || "http://localhost:4040").replace(/\/$/, "");
  const url = `${baseUrl}/share/${shareUid}?secret=${encodeURIComponent(secret)}`;

  const entry = itemsForEntry.map((i) => toSubsonicSong(i));

  return {
    shares: {
      share: [
        {
          id: shareUid,
          url,
          description: description ?? undefined,
          username: auth.subsonicUsername,
          created: new Date().toISOString(),
          visitCount: 0,
          entry,
        },
      ],
    },
  };
}

/** OpenSubsonic getShares: list shares for the authenticated user with entry[] from entry_ids_flat. */
export async function handleGetShares(auth: AuthResult): Promise<Record<string, unknown>> {
  const shares = getSharesForUser(auth.subsonicUsername);
  const baseUrl = (config.subfinPublicUrl || "http://localhost:4040").replace(/\/$/, "");
  const ctx = toJellyfinContext(auth);
  const shareList: Record<string, unknown>[] = [];

  for (const s of shares) {
    let flatIds: string[] = [];
    try {
      flatIds = JSON.parse(s.entry_ids_flat) as string[];
      if (!Array.isArray(flatIds)) flatIds = [];
    } catch {
      flatIds = [];
    }
    const entries: Record<string, unknown>[] = [];
    for (const id of flatIds) {
      const song = await jf.getSong(ctx, id);
      if (song) entries.push(toSubsonicSong(song));
    }
    const url = `${baseUrl}/share/${s.share_uid}`;
    shareList.push({
      id: s.share_uid,
      url,
      description: s.description ?? undefined,
      username: auth.subsonicUsername,
      created: s.created_at,
      visitCount: s.visit_count ?? 0,
      entry: entries,
    });
  }

  return { shares: { share: shareList } };
}

/** OpenSubsonic updateShare: update description and/or expires. */
export async function handleUpdateShare(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing share id");
  const description = params.description?.trim();
  const expiresRaw = params.expires?.trim();
  const expiresAt = expiresRaw !== undefined && expiresRaw !== "" ? Number.parseInt(expiresRaw, 10) : undefined;
  const ok = storeUpdateShare(id, auth.subsonicUsername, {
    description: description !== undefined ? description : undefined,
    expiresAt: expiresAt !== undefined ? expiresAt : undefined,
  });
  if (!ok) throw new Error("Share not found or access denied");
  return {};
}

/** OpenSubsonic deleteShare: delete share and unlink device (revoke password). */
export async function handleDeleteShare(auth: AuthResult, params: Record<string, string>): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (!id) throw new Error("Missing share id");
  const ok = storeDeleteShare(id, auth.subsonicUsername);
  if (!ok) throw new Error("Share not found or access denied");
  return {};
}

/** Returns Jellyfin stream URL used by the router to proxy the audio response. */
export function getStreamRedirectUrl(
  auth: AuthResult,
  id: string,
  maxBitRateKbps?: number,
  format?: string
): string {
  return jf.getStreamUrl(toJellyfinContext(auth), auth.jellyfinUserId, id, maxBitRateKbps, format);
}

/** Returns Jellyfin download URL used by the router to proxy the original audio file. */
export function getDownloadRedirectUrl(auth: AuthResult, id: string): string {
  const cleanId = stripSubsonicIdPrefix(id);
  return jf.getDownloadUrl(toJellyfinContext(auth), auth.jellyfinUserId, cleanId);
}

/** Fire-and-forget: notify Jellyfin that playback started. Only used when the client explicitly
 * signals "now playing" (e.g. scrobble with submission=false). We do not call this on stream
 * requests because clients like SubTUI pre-fetch the next track for gapless playback. */
export function notifyPlaybackStart(auth: AuthResult, id: string): void {
  void jf.reportPlaybackStart(toJellyfinContext(auth), auth.jellyfinUserId, id);
}

/** Returns Jellyfin image URL for cover art; router proxies the response. */
export function getCoverArtRedirectUrl(auth: AuthResult, id: string, size?: number): string | null {
  let jellyfinId = id;
  // Some clients (e.g. Subtracks) probe coverArt with sentinel ids like -1. Jellyfin
  // will 400 on /Items/-1/Images/Primary. We short-circuit these so we don't spam
  // Jellyfin with bad requests; the router should treat this as "not found".
  if (jellyfinId === "-1") {
    return null;
  }
  // Our coverArt IDs are prefixed for artists/albums/playlists: ar-<id>, al-<id>, pl-<id>.
  if (id.startsWith("ar-") || id.startsWith("al-") || id.startsWith("pl-")) {
    jellyfinId = id.slice(3);
  }
  return jf.getImageUrl(toJellyfinContext(auth), jellyfinId, "Primary", size);
}

/** Returns Jellyfin avatar URL for the authenticated user; router proxies the response. */
export function getAvatarRedirectUrl(
  auth: AuthResult,
  username?: string,
  size?: number
): string | null {
  if (username != null && username.trim() !== "" && username.trim() !== auth.subsonicUsername) {
    return null;
  }
  return jf.getUserAvatarUrl(toJellyfinContext(auth), auth.jellyfinUserId, size);
}

/** Save play queue for this user (OpenSubsonic savePlayQueue). One queue per user for cross-device continuity. */
export async function handleSavePlayQueue(
  auth: AuthResult,
  params: Record<string, string> & { playQueueIds?: string[] }
): Promise<Record<string, unknown>> {
  const ids = params.playQueueIds ?? [];
  const rawIds = Array.isArray(ids) ? ids : [];
  const entryIds = rawIds
    .map((id) => (typeof id === "string" ? id : String(id)).trim())
    .filter((id) => id && id !== "[object Object]")
    .map((id) => stripSubsonicIdPrefix(id));

  if (entryIds.length === 0) {
    clearPlayQueue(auth.subsonicUsername);
    return {};
  }

  const currentRaw = (params.current ?? "").trim();
  const currentId = currentRaw ? stripSubsonicIdPrefix(currentRaw) : null;
  const positionMs = Math.max(0, Number.parseInt(params.position ?? "0", 10) || 0);
  const changedBy = (params.changedBy ?? params.c ?? "").trim().slice(0, 255);

  savePlayQueue(auth.subsonicUsername, {
    entryIds,
    currentId: currentId && entryIds.includes(currentId) ? currentId : entryIds[0] ?? null,
    positionMs,
    changedBy,
  });
  return {};
}

/** Return saved play queue for this user with full entry metadata from Jellyfin (OpenSubsonic getPlayQueue). */
export async function handleGetPlayQueue(auth: AuthResult): Promise<Record<string, unknown>> {
  const queue = getPlayQueue(auth.subsonicUsername);
  if (!queue || queue.entryIds.length === 0) {
    return {
      playQueue: {
        position: 0,
        username: auth.subsonicUsername,
        changed: new Date().toISOString(),
        changedBy: "",
        entry: [],
      },
    };
  }

  const ctx = toJellyfinContext(auth);
  const entries: Record<string, unknown>[] = [];
  for (const id of queue.entryIds) {
    const song = await jf.getSong(ctx, id);
    if (song) {
      const albumId = (song as Record<string, unknown>).AlbumId as string | undefined;
      const albumName = song.Album ?? undefined;
      const artistName = song.AlbumArtist ?? song.Artists?.[0] ?? "";
      entries.push(toSubsonicSong(song, albumId, albumName, artistName));
    }
  }

  return {
    playQueue: {
      current: queue.currentId ?? (queue.entryIds[0] ?? ""),
      position: queue.positionMs,
      username: auth.subsonicUsername,
      changed: queue.changedAt,
      changedBy: queue.changedBy,
      entry: entries,
    },
  };
}
