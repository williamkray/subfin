/**
 * Map Jellyfin BaseItemDto to OpenSubsonic response shapes.
 */
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models/base-item-dto.js";

const IGNORED_ARTICLES = "The An A Die Das Ein Eine Les Le La";

export function ticksToSeconds(ticks: number | null | undefined): number {
  if (ticks == null) return 0;
  return Math.floor(ticks / 10_000_000);
}

function indexLetter(name: string | null | undefined): string {
  if (!name || !name.trim()) return "#";
  const first = name.trim()[0]!.toUpperCase();
  if (/[A-Z0-9]/.test(first)) return first;
  return "#";
}

/** Subsonic artist (in index list). */
export function toSubsonicArtist(item: BaseItemDto): Record<string, unknown> {
  return {
    id: item.Id,
    name: item.Name ?? "",
    coverArt: item.Id ? `ar-${item.Id}` : undefined,
    albumCount: item.AlbumCount ?? 0,
  };
}

/** Subsonic album (in artist view). */
export function toSubsonicAlbumShort(item: BaseItemDto): Record<string, unknown> {
  const created = item.DateCreated ?? new Date(0).toISOString();
  const albumArtistIds = (item as Record<string, string[] | undefined>).AlbumArtistIds;
  const primaryArtistId = Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : undefined;
  return {
    id: item.Id,
    name: item.Name ?? "",
    coverArt: item.Id ? `al-${item.Id}` : undefined,
    songCount: item.ChildCount ?? 0,
    artist: item.AlbumArtist ?? item.Artists?.[0] ?? "",
    artistId: primaryArtistId ? `ar-${primaryArtistId}` : undefined,
    year: item.ProductionYear ?? undefined,
    created,
  };
}

/** Strip Subsonic-style prefix (ar-, al-, pl-) so we can pass raw id to Jellyfin. */
export function stripSubsonicIdPrefix(id: string): string {
  return id.replace(/^(ar-|al-|pl-)/i, "");
}

/** Subsonic song (child). Use real artistId/albumId when available so "go to artist/album" works. */
export function toSubsonicSong(item: BaseItemDto, albumId?: string, albumName?: string, artistName?: string): Record<string, unknown> {
  const duration = ticksToSeconds(item.RunTimeTicks);
  const size = (item as Record<string, number | undefined>).Size ?? 0;
  const bitRate = duration > 0 && size > 0 ? Math.floor((size * 8) / duration / 1000) : undefined;
  const anyItem = item as Record<string, any>;
  // Prefer explicit albumId argument, then Jellyfin AlbumId, then ParentId as a last resort.
  const albumIdFromItem = anyItem.AlbumId as string | undefined;
  const effectiveAlbumId = albumId ?? albumIdFromItem ?? item.ParentId;
  // Prefer AlbumArtistIds, then ArtistItems, then ArtistIds for stable artist id.
  const albumArtistIds = anyItem.AlbumArtistIds as string[] | undefined;
  const artistItems = anyItem.ArtistItems as { Id?: string }[] | undefined;
  const artistIds = anyItem.ArtistIds as string[] | undefined;
  let effectiveArtistId: string | undefined;
  if (Array.isArray(albumArtistIds) && albumArtistIds.length > 0) {
    effectiveArtistId = albumArtistIds[0];
  } else if (Array.isArray(artistItems) && artistItems.length > 0 && artistItems[0]?.Id) {
    effectiveArtistId = String(artistItems[0].Id);
  } else if (Array.isArray(artistIds) && artistIds.length > 0) {
    effectiveArtistId = artistIds[0];
  }
  const primaryArtistName = artistName ?? item.AlbumArtist ?? item.Artists?.[0] ?? "";
  return {
    id: item.Id,
    parent: effectiveAlbumId,
    title: item.Name ?? "",
    isDir: false,
    isVideo: false,
    type: "music",
    // OpenSubsonic: explicit mediaType helps clients (e.g. Castafiore)
    // choose the right player pipeline and handle offline caches correctly.
    mediaType: "audio",
    albumId: effectiveAlbumId ? `al-${effectiveAlbumId}` : undefined,
    album: albumName ?? item.Album ?? "",
    artistId: effectiveArtistId ? `ar-${effectiveArtistId}` : undefined,
    artist: primaryArtistName,
    // OpenSubsonic / Navic extensions for display fields.
    displayArtist: primaryArtistName,
    displayAlbumArtist: primaryArtistName,
    displayComposer: (item as Record<string, string | undefined>).Composer ?? "",
    coverArt: item.Id,
    duration,
    bitRate: bitRate ?? 0,
    track: item.IndexNumber ?? 0,
    year: item.ProductionYear ?? undefined,
    genre: item.Genres?.[0] ?? undefined,
    size,
    // Advertise the actual stream format (MP3) so clients that cache from stream get correct
    // suffix/MIME and can play offline (e.g. Castafiore, DSub, Youamp). Subfin's stream
    // endpoint uses Jellyfin universal audio and serves MP3; download.view serves original.
    suffix: "mp3",
    contentType: "audio/mpeg",
    // OpenSubsonic: some clients look at transcoded* when the underlying file is different
    // from the stream format; we always stream MP3 today.
    transcodedSuffix: "mp3",
    transcodedContentType: "audio/mpeg",
    discNumber: item.ParentIndexNumber ?? 1,
    path: (item as Record<string, string | undefined>).Path,
  };
}

/** Subsonic album with songs. */
export function toSubsonicAlbum(
  album: BaseItemDto,
  songs: BaseItemDto[],
  token: string
): Record<string, unknown> {
  const artistName = album.AlbumArtist ?? album.Name ?? "";
  const created = album.DateCreated ?? new Date(0).toISOString();
  const albumArtistIds = (album as Record<string, string[] | undefined>).AlbumArtistIds;
  const primaryArtistId = Array.isArray(albumArtistIds) && albumArtistIds.length > 0 ? albumArtistIds[0] : undefined;
  return {
    id: album.Id,
    parent: album.ParentId,
    album: album.Name ?? "",
    title: album.Name ?? "",
    name: album.Name ?? "",
    isDir: true,
    coverArt: album.Id ? `al-${album.Id}` : undefined,
    songCount: songs.length,
    created,
    duration: songs.reduce((sum, s) => sum + ticksToSeconds(s.RunTimeTicks), 0),
    playCount: 0,
    artistId: primaryArtistId ? `ar-${primaryArtistId}` : undefined,
    artist: artistName,
    year: album.ProductionYear ?? undefined,
    genre: album.Genres?.[0] ?? undefined,
    song: songs.map((s) => toSubsonicSong(s, album.Id ?? undefined, album.Name ?? undefined, artistName)),
  };
}

/** Subsonic artist with albums. */
export function toSubsonicArtistWithAlbums(
  artist: BaseItemDto,
  albums: BaseItemDto[]
): Record<string, unknown> {
  return {
    id: artist.Id,
    name: artist.Name ?? "",
    coverArt: artist.Id ? `ar-${artist.Id}` : undefined,
    albumCount: albums.length,
    album: albums.map(toSubsonicAlbumShort),
  };
}

/** Build getArtists index structure (by letter). */
export function toSubsonicArtistsIndex(artists: BaseItemDto[]): Record<string, unknown> {
  const byLetter = new Map<string, Record<string, unknown>[]>();
  for (const a of artists) {
    const letter = indexLetter(a.Name);
    if (!byLetter.has(letter)) byLetter.set(letter, []);
    byLetter.get(letter)!.push(toSubsonicArtist(a) as Record<string, unknown>);
  }
  const index = Array.from(byLetter.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, artist]) => ({ name, artist }));
  return {
    ignoredArticles: IGNORED_ARTICLES,
    index,
  };
}
