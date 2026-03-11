import { config } from "../config.js";
import { getDerivedCache, setDerivedCache } from "../store/index.js";

export interface LastFmArtistInfo {
  biography: string;
  lastFmUrl: string;
}

interface LastFmArtistGetInfoResponse {
  artist?: {
    url?: string;
    bio?: {
      summary?: string;
      content?: string;
    };
  };
  error?: number;
  message?: string;
}

function stripHtml(input: string): string {
  // Very small sanitizer: strip tags and decode a few common entities.
  const noTags = input.replace(/<[^>]*>/g, "");
  return noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchFromLastFm(params: URLSearchParams): Promise<LastFmArtistInfo | null> {
  const apiKey = config.lastFmApiKey;
  if (!apiKey) return null;

  params.set("api_key", apiKey);
  params.set("format", "json");
  params.set("method", "artist.getinfo");

  const url = `https://ws.audioscrobbler.com/2.0/?${params.toString()}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as LastFmArtistGetInfoResponse;
    if (!data.artist || data.error) return null;
    const urlField = data.artist.url ?? "";
    const bioRaw = data.artist.bio?.content ?? data.artist.bio?.summary ?? "";
    const biography = stripHtml(bioRaw).trim();
    return {
      biography,
      lastFmUrl: urlField,
    };
  } catch {
    return null;
  }
}

/** Get enriched artist info from Last.fm, using MusicBrainz ID when available and caching results in derived_cache. */
export async function getLastFmArtistInfo(opts: {
  musicBrainzId?: string;
  name: string;
}): Promise<LastFmArtistInfo | null> {
  const apiKey = config.lastFmApiKey;
  if (!apiKey) return null;

  const mbid = opts.musicBrainzId?.trim();
  const normalizedName = opts.name.trim();
  if (!normalizedName) return null;

  const cacheKey = mbid
    ? `lastfm:artist:mbid:${mbid}`
    : `lastfm:artist:name:${normalizedName.toLowerCase()}`;
  const ttlMs = 24 * 60 * 60 * 1000; // 24 hours

  const existing = getDerivedCache<LastFmArtistInfo>(cacheKey);
  if (existing && existing.value && existing.cachedAt) {
    const ageMs = Date.now() - new Date(existing.cachedAt).getTime();
    if (ageMs < ttlMs) {
      return existing.value;
    }
  }

  const params = new URLSearchParams();
  if (mbid) {
    params.set("mbid", mbid);
  } else {
    params.set("artist", normalizedName);
  }

  const fresh = await fetchFromLastFm(params);
  if (!fresh) {
    return null;
  }
  setDerivedCache<LastFmArtistInfo>(cacheKey, fresh, null);
  return fresh;
}

