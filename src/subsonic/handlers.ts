/**
 * OpenSubsonic method handlers. Each receives auth result and query params, returns Subsonic-shaped payload or throws.
 */
import * as jf from "../jellyfin/client.js";
import { config } from "../config.js";
import {
  stripSubsonicIdPrefix,
  toSubsonicArtistsIndex,
  toSubsonicArtistWithAlbums,
  toSubsonicAlbum,
  toSubsonicSong,
  ticksToSeconds,
} from "./mappers.js";
import type { AuthResult } from "./auth.js";

/** Resolve effective music folder id(s) for list endpoints: client param wins; else MUSIC_LIBRARY_IDS when set. Returns null = no restriction, [] = no allowed folders, [id...] = use these. */
async function getEffectiveMusicFolderIds(
  auth: AuthResult,
  clientMusicFolderId?: string
): Promise<string[] | null> {
  const trimmed = clientMusicFolderId?.trim();
  if (trimmed) return [trimmed];
  return jf.getAllowedMusicFolderIds(auth.jellyfinAccessToken, auth.jellyfinUserId);
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
    openSubsonicExtensions: {
      extension: [
        { name: "transcoders", versions: ["1.0.0"] },
        { name: "formats", versions: ["1.0.0"] },
        { name: "lyrics", versions: ["1.0.0"] },
        { name: "songLyrics", versions: ["1.0.0"] },
      ],
    },
  };
}

export async function handleGetMusicFolders(auth: AuthResult): Promise<Record<string, unknown>> {
  const folders = await jf.getMusicLibraries(auth.jellyfinAccessToken, auth.jellyfinUserId);
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
  let artists: Awaited<ReturnType<typeof jf.getArtists>>;
  if (folderIds === null) {
    artists = await jf.getArtists(auth.jellyfinAccessToken, undefined);
  } else if (folderIds.length === 0) {
    artists = [];
  } else if (folderIds.length === 1) {
    artists = await jf.getArtists(auth.jellyfinAccessToken, folderIds[0]);
  } else {
    const results = await Promise.all(
      folderIds.map((id) => jf.getArtists(auth.jellyfinAccessToken, id))
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getArtists>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    artists = Array.from(byId.values());
  }
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
  let artists: Awaited<ReturnType<typeof jf.getArtists>>;
  if (folderIds === null) {
    artists = await jf.getArtists(auth.jellyfinAccessToken, undefined);
  } else if (folderIds.length === 0) {
    artists = [];
  } else if (folderIds.length === 1) {
    artists = await jf.getArtists(auth.jellyfinAccessToken, folderIds[0]);
  } else {
    const results = await Promise.all(
      folderIds.map((id) => jf.getArtists(auth.jellyfinAccessToken, id))
    );
    const byId = new Map<string, Awaited<ReturnType<typeof jf.getArtists>>[number]>();
    for (const list of results) for (const a of list) if (a.Id) byId.set(a.Id, a);
    artists = Array.from(byId.values());
  }
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
  const [artist, albums] = await Promise.all([
    jf.getArtist(auth.jellyfinAccessToken, cleanId),
    jf.getAlbumsByArtist(auth.jellyfinAccessToken, cleanId),
  ]);
  if (!artist) throw new Error("NotFound");
  return {
    artist: toSubsonicArtistWithAlbums(artist, albums),
  };
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
  const album = await jf.getAlbum(auth.jellyfinAccessToken, cleanId);
  if (album) {
    const songs = await jf.getSongsByAlbum(auth.jellyfinAccessToken, cleanId);
    const artistName = album.AlbumArtist ?? album.Artists?.[0] ?? "";
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
    jf.getArtist(auth.jellyfinAccessToken, cleanId),
    jf.getAlbumsByArtist(auth.jellyfinAccessToken, cleanId),
  ]);
  if (!artist) {
    throw new Error("NotFound");
  }
  const artistName = artist.Name ?? "";
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
  const [album, songs] = await Promise.all([
    jf.getAlbum(auth.jellyfinAccessToken, cleanId),
    jf.getSongsByAlbum(auth.jellyfinAccessToken, cleanId),
  ]);
  if (!album) throw new Error("NotFound");
  return {
    album: toSubsonicAlbum(album, songs, auth.jellyfinAccessToken),
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
    albums = await jf.getAlbumsForLibrary(auth.jellyfinAccessToken, {
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
    albums = await jf.getAlbumsForLibrary(auth.jellyfinAccessToken, {
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
        jf.getAlbumsForLibrary(auth.jellyfinAccessToken, {
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
    } else if (typeLower === "alphabeticalbyname" || typeLower === "alphabeticalbyartist") {
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
      album: albums.map((a) => ({
        id: a.Id,
        name: a.Name ?? "",
        artist: a.AlbumArtist ?? a.Artists?.[0] ?? "",
        artistId: (() => {
          const albumArtistIds = (a as { AlbumArtistIds?: string[] }).AlbumArtistIds;
          const primaryArtistId =
            Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : undefined;
          return primaryArtistId ? `ar-${primaryArtistId}` : undefined;
        })(),
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
      })),
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
  const pls = await jf.getPlaylists(auth.jellyfinAccessToken, auth.jellyfinUserId);
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

  const items = await jf.getPlaylistItems(
    auth.jellyfinAccessToken,
    id,
    auth.jellyfinUserId
  );
  const name = params.name?.trim() || "";
  const songCount = items.length;

  return {
    playlist: {
      id,
      name,
      owner: auth.subsonicUsername,
      public: false,
      created: new Date(0).toISOString(),
      changed: undefined,
      duration: 0,
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
      await jf.updatePlaylistMetadata(auth.jellyfinAccessToken, playlistId, {
        Name: name,
        ...(params.public !== undefined && { IsPublic: isPublic }),
      });
      const current = await jf.getPlaylistItems(
        auth.jellyfinAccessToken,
        playlistId,
        auth.jellyfinUserId
      );
      const currentIds = current.map((i) => i.Id!).filter(Boolean);
      if (currentIds.length > 0) {
        await jf.removeItemsFromPlaylist(
          auth.jellyfinAccessToken,
          playlistId,
          currentIds
        );
      }
      if (songIds.length > 0) {
        await jf.addItemsToPlaylist(
          auth.jellyfinAccessToken,
          playlistId,
          auth.jellyfinUserId,
          songIds
        );
      }
      return { playlist: { id: playlistId, name } };
    }
    const id = await jf.createPlaylist(
      auth.jellyfinAccessToken,
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
      await jf.updatePlaylistMetadata(auth.jellyfinAccessToken, playlistId, {
        Name: name,
      });
    }
    if (comment !== undefined || params.public !== undefined) {
      await jf.updatePlaylistMetadata(auth.jellyfinAccessToken, playlistId, {
        IsPublic: params.public !== undefined ? isPublic : undefined,
      });
    }

    const items = await jf.getPlaylistItems(
      auth.jellyfinAccessToken,
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
          auth.jellyfinAccessToken,
          playlistId,
          idsToRemove
        );
      }
    }

    if (songIdsToAdd.length > 0) {
      await jf.addItemsToPlaylist(
        auth.jellyfinAccessToken,
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
    await jf.deletePlaylist(auth.jellyfinAccessToken, id);
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
    const item = await jf.getItemById(auth.jellyfinAccessToken, artistId);
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
    jf.getArtistWithInfo(auth.jellyfinAccessToken, resolvedArtistId),
    jf.getSimilarArtists(auth.jellyfinAccessToken, auth.jellyfinUserId, resolvedArtistId, count),
  ]);

  const baseUrl = config.subfinPublicUrl;
  const coverId = "ar-" + resolvedArtistId;
  const imageUrl = (size?: number) =>
    baseUrl ? `${baseUrl}/rest/getCoverArt?id=${encodeURIComponent(coverId)}${size ? `&size=${size}` : ""}` : undefined;

  const artistName = (artist as { Name?: string } | null)?.Name ?? "";
  return {
    artistInfo: {
      name: artistName,
      biography: (artist as { Overview?: string } | null)?.Overview?.trim() ?? "",
      musicBrainzId:
        (artist as { ProviderIds?: { MusicBrainzArtist?: string; MusicBrainz?: string } } | null)?.ProviderIds
          ?.MusicBrainzArtist ??
        (artist as { ProviderIds?: { MusicBrainz?: string } } | null)?.ProviderIds?.MusicBrainz ??
        "",
      lastFmUrl: "",
      smallImageUrl: imageUrl(34),
      mediumImageUrl: imageUrl(64),
      largeImageUrl: imageUrl(174) ?? imageUrl(300),
      similarArtist: similar.map((a) => ({
        id: a.Id ? "ar-" + a.Id : undefined,
        name: a.Name ?? "",
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

/** getStarred / getStarred2: favorites backed by Jellyfin user favorites (songs only for now). */
export async function handleGetStarred(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const size = Number.parseInt(params.size ?? "200", 10) || 200;
  const offset = Number.parseInt(params.offset ?? "0", 10) || 0;
  const musicFolderId = params.musicFolderId?.trim() || undefined;
  const [albums, songs] = await Promise.all([
    jf.getFavoriteAlbums(auth.jellyfinAccessToken, { musicFolderId, size, offset }),
    jf.getFavoriteSongs(auth.jellyfinAccessToken, { musicFolderId, size, offset }),
  ]);
  return {
    starred: {
      artist: [],
      album: albums.map((a) => ({
        id: a.Id,
        name: a.Name ?? "",
        artist: a.AlbumArtist ?? a.Artists?.[0] ?? "",
        artistId: (() => {
          const albumArtistIds = (a as { AlbumArtistIds?: string[] }).AlbumArtistIds;
          const primaryArtistId =
            Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : undefined;
          return primaryArtistId ? `ar-${primaryArtistId}` : undefined;
        })(),
        created: a.DateCreated ?? new Date(0).toISOString(),
      })),
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

  const folderIds = await getEffectiveMusicFolderIds(auth, params.musicFolderId);
  let songs: Awaited<ReturnType<typeof jf.getRandomSongs>>;
  if (folderIds === null) {
    songs = await jf.getRandomSongs(auth.jellyfinAccessToken, { size, offset });
  } else if (folderIds.length === 0) {
    songs = [];
  } else if (folderIds.length === 1) {
    songs = await jf.getRandomSongs(auth.jellyfinAccessToken, {
      musicFolderId: folderIds[0],
      size,
      offset,
    });
  } else {
    const needed = offset + size;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.getRandomSongs(auth.jellyfinAccessToken, {
          musicFolderId,
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
      genres = await jf.getGenres(auth.jellyfinAccessToken, {});
    } else if (folderIds.length === 0) {
      genres = [];
    } else if (folderIds.length === 1) {
      genres = await jf.getGenres(auth.jellyfinAccessToken, {
        musicFolderId: folderIds[0],
      });
    } else {
      const results = await Promise.all(
        folderIds.map((musicFolderId) =>
          jf.getGenres(auth.jellyfinAccessToken, { musicFolderId })
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
    songs = await jf.getSongsByGenre(auth.jellyfinAccessToken, genre, { size, offset });
  } else if (folderIds.length === 0) {
    songs = [];
  } else if (folderIds.length === 1) {
    songs = await jf.getSongsByGenre(auth.jellyfinAccessToken, genre, {
      musicFolderId: folderIds[0],
      size,
      offset,
    });
  } else {
    const needed = offset + size;
    const results = await Promise.all(
      folderIds.map((musicFolderId) =>
        jf.getSongsByGenre(auth.jellyfinAccessToken, genre, {
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
  const entries = await jf.getNowPlayingForUser(auth.jellyfinAccessToken, auth.jellyfinUserId);
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

/** scrobble: accept and ignore playback reports (no-op). */
export async function handleScrobble(
  auth: AuthResult,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const id = params.id?.trim();
  if (id) {
    const timeMs = params.time ? Number.parseInt(params.time, 10) || undefined : undefined;
    const submission = (params.submission ?? params.submitted ?? "").toLowerCase();
    const isSubmission =
      submission === "true" || submission === "1" || submission === "yes" || submission === "";

    // When submission is false, treat this as a "now playing" update and start a Jellyfin session.
    if (!isSubmission) {
      void jf.reportPlaybackStart(auth.jellyfinAccessToken, auth.jellyfinUserId, id);
    }

    // Use scrobble as a lightweight signal that this item is (or was) playing.
    // Many clients send scrobble repeatedly; reporting progress is cheap and helps Jellyfin show activity.
    void jf.reportPlaybackProgress(auth.jellyfinAccessToken, auth.jellyfinUserId, id, timeMs);

    // When submission is true (or omitted, which defaults to true), treat this as an end-of-track scrobble
    // and notify Jellyfin that playback stopped.
    if (isSubmission) {
      void jf.reportPlaybackStopped(auth.jellyfinAccessToken, auth.jellyfinUserId, id, timeMs);
    }
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
    await jf.setUserLikeForItem(auth.jellyfinAccessToken, auth.jellyfinUserId, id, likes);
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
        jf.markFavorite(auth.jellyfinAccessToken, auth.jellyfinUserId, id)
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
        jf.unmarkFavorite(auth.jellyfinAccessToken, auth.jellyfinUserId, id)
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
  const songs = await jf.getTopSongsForArtist(auth.jellyfinAccessToken, artistName, count);
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
    auth.jellyfinAccessToken,
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
    auth.jellyfinAccessToken,
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
    const song = await jf.getSong(auth.jellyfinAccessToken, id);
    if (song) {
      itemId = song.Id ?? null;
      artistName = song.AlbumArtist ?? song.Artists?.[0] ?? artistName;
      titleName = song.Name ?? titleName;
    }
  } else if (artist || title) {
    const query = [artist, title].filter(Boolean).join(" ");
    let songs = await jf.searchSongs(auth.jellyfinAccessToken, query, { size: 8 });
    // When full-text search returns 0, fall back to resolve by artist then filter by title (same track can be found)
    if (songs.length === 0 && (artist?.trim() || title?.trim())) {
      if (logRest) {
        console.log("[LYRICS] getLyrics search returned 0 results query=\"" + query + "\", trying artist+title fallback");
      }
      songs = await jf.resolveSongsByArtistAndTitle(auth.jellyfinAccessToken, artist ?? "", title ?? "", { limit: 8 });
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
            .getLyricsForItem(auth.jellyfinAccessToken, sid)
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
    (await jf.getLyricsForItem(auth.jellyfinAccessToken, itemId))?.value ||
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
  const song = await jf.getSong(auth.jellyfinAccessToken, itemId);
  const displayArtist = song?.AlbumArtist ?? song?.Artists?.[0] ?? "";
  const displayTitle = song?.Name ?? "";
  const lyricsResult = await jf.getLyricsForItem(auth.jellyfinAccessToken, itemId);
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
  const musicFolderId = params.musicFolderId?.trim() || undefined;

  const [artists, albums, songs] = await Promise.all([
    jf.searchArtists(auth.jellyfinAccessToken, query, {
      size: artistCount,
      offset: artistOffset,
      musicFolderId,
    }),
    jf.searchAlbums(auth.jellyfinAccessToken, query, {
      size: albumCount,
      offset: albumOffset,
      musicFolderId,
    }),
    jf.searchSongs(auth.jellyfinAccessToken, query, {
      size: songCount,
      offset: songOffset,
      musicFolderId,
    }),
  ]);

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
  const song = await jf.getSong(auth.jellyfinAccessToken, cleanId);
  if (!song) throw new Error("NotFound");
  return {
    song: toSubsonicSong(song),
  };
}

/** Returns Jellyfin stream URL used by the router to proxy the audio response. */
export function getStreamRedirectUrl(
  auth: AuthResult,
  id: string,
  maxBitRateKbps?: number,
  format?: string
): string {
  return jf.getStreamUrl(auth.jellyfinAccessToken, auth.jellyfinUserId, id, maxBitRateKbps, format);
}

/** Returns Jellyfin download URL used by the router to proxy the original audio file. */
export function getDownloadRedirectUrl(auth: AuthResult, id: string): string {
  const cleanId = stripSubsonicIdPrefix(id);
  return jf.getDownloadUrl(auth.jellyfinAccessToken, auth.jellyfinUserId, cleanId);
}

/** Fire-and-forget hook so router can notify Jellyfin about playback starting. */
export function notifyPlaybackStart(auth: AuthResult, id: string): void {
  void jf.reportPlaybackStart(auth.jellyfinAccessToken, auth.jellyfinUserId, id);
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
  return jf.getImageUrl(auth.jellyfinAccessToken, jellyfinId, "Primary", size);
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
  return jf.getUserAvatarUrl(auth.jellyfinAccessToken, auth.jellyfinUserId, size);
}

/** Stub: save play queue (no-op so clients don't error). */
export async function handleSavePlayQueue(): Promise<Record<string, unknown>> {
  return {};
}

/** Stub: return empty play queue (Jellyfin has its own queue; clients often call this). */
export async function handleGetPlayQueue(): Promise<Record<string, unknown>> {
  return {
    playQueue: {
      position: 0,
      username: "",
      changed: new Date().toISOString(),
      changedBy: "",
      entry: [],
    },
  };
}
