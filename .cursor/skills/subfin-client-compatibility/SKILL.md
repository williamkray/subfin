---
name: subfin-client-compatibility
description: Guidance for implementing and evolving Subfin's OpenSubsonic/Subsonic mappings for maximum compatibility across clients like DSub, Tempus, Musly, Navic, and others. Use when adding or changing API handlers, mappers, or cover-art/lyrics/playlist behavior, or when debugging a client-specific issue.
---

# Subfin Client Compatibility

## When to use this skill

Use these instructions whenever you:

- Change Subfin's Subsonic/OpenSubsonic handlers or mappers.
- Debug issues from specific clients (DSub, Tempus, Musly, Navic, etc.).
- Add new endpoints or fields to existing responses.

The goal is to keep Subfin "more compatible than strict" while still following the OpenSubsonic spec.

## Core principles

- **Favor OpenSubsonic extensions**  
  - Implement OpenSubsonic fields that clients commonly rely on, even if marked optional in the spec.  
  - Treat "required in clients" as effectively required in Subfin.

- **Be generous, not minimal**  
  - If a field is easy to supply and might be useful to some client, include it.  
  - Use sensible fallbacks so required/important fields are never missing.

- **Enrich server metadata before blaming clients**  
  - When a client feature appears broken (e.g. \"view album\", \"view artist\", track info fields missing), first look for ways to enrich Subfin's mappings (add `albumId`, `artistId`, `display*`, `created`, `coverArt`, etc.) so the client has what it expects.  
  - Only call something a \"client bug\" after you've confirmed that Subfin returns complete, spec-aligned metadata for that flow and the client is still misbehaving in spite of it.

- **Keep JSON and XML in sync**  
  - Any new field in the JSON payload should also be represented in the XML branch (and vice versa) unless the spec explicitly says otherwise.  
  - For XML, follow attribute vs. element conventions established by Subsonic/OpenSubsonic.

- **Respect id conventions**  
  - Use stable prefixes that map cleanly back to Jellyfin:
    - `ar-<id>` for artists  
    - `al-<id>` for albums  
    - `pl-<id>` for playlists  
  - Ensure all endpoints that accept `id` or `coverArt` understand and strip these prefixes before calling Jellyfin.

- **Test with multiple clients**  
  - Use strict/typed clients (like Navic) to surface missing fields.  
  - Use older XML-focused clients (like DSub) to verify XML structure and attributes.

## Song / track mapping rules

When editing `toSubsonicSong` or adding similar song mappers:

- **Always include classic Subsonic fields**  
  - `id`, `parent`, `title`, `album`, `artist`, `track`, `year`, `genre`, `duration`, `size`, `suffix`, `contentType`, `discNumber`, `path`, `coverArt`, `albumId`, `artistId`, `type`, `isDir`, `isVideo`.

- **Always include these OpenSubsonic / Navic-required fields**  
  - `displayArtist`  
  - `displayAlbumArtist`  
  - `displayComposer`

- **Derive values consistently**  
  - `primaryArtistName` should be:
    - explicit `artistName` argument if provided, else  
    - `item.AlbumArtist`, else  
    - `item.Artists?.[0]`, else `""`.
  - Use `primaryArtistName` for:
    - `artist`  
    - `displayArtist`  
    - `displayAlbumArtist`
  - For `displayComposer`, prefer a direct `Composer` field from Jellyfin when available; otherwise use `""` (never omit the field).

- **Never omit required fields in JSON**  
  - If a client model (e.g. Navic’s `Track`) marks a field as non-nullable, ensure Subfin always includes it in JSON, using `""` or `0` as safe fallbacks when there is no real value.

## Artist info rules

When working on `getArtistInfo` / `getArtistInfo2`:

- **Always include the artist name**  
  - Add a `name` field in the `artistInfo` object, derived from Jellyfin’s artist `Name`.  
  - In XML, include:
    - `<name>...</name>` element, and  
    - a `name="..."` attribute on the root `<artistInfo>` / `<artistInfo2>` element when a non-empty name is present.

- **Image URLs and public URL**  
  - When `SUBFIN_PUBLIC_URL` is set, build absolute `smallImageUrl`, `mediumImageUrl`, and `largeImageUrl` using Subfin’s `getCoverArt` endpoint and the artist’s `ar-<id>` coverArt id.  
  - Sizes should follow the OpenSubsonic examples (e.g. 34, 64, 174) but fall back gracefully if a size is missing.

- **Similar artists**  
  - Represent each similar artist with at least `id` and `name`, using `ar-<id>` ids and Jellyfin’s `Name`.

## Playlist rules

When working on `getPlaylists` and `getPlaylist`:

- **Expose playlist-level `coverArt`**  
  - In `getPlaylists`, include `coverArt: "pl-<playlistId>"` when `playlistId` is present.  
  - In `getPlaylist`, also include `coverArt: "pl-<playlistId>"` on the playlist object, so clients can show artwork in both list and detail views.

- **Ensure `getCoverArt` understands playlist ids**  
  - `getCoverArt` must strip the `pl-` prefix and map to the Jellyfin playlist id when building the Jellyfin image URL.

- **Keep read-only vs write APIs clear**  
  - For now, treat playlists as read-only (`getPlaylists`, `getPlaylist`); don’t pretend to support `createPlaylist`/`updatePlaylist`/`deletePlaylist` until they are truly implemented.

## Lyrics rules

When working on lyrics endpoints:

- **Support both id-based and text-based lookups**  
  - Prefer id-based lookups (`getLyricsBySongId?id=...` or `getLyrics?id=...`) for reliability.  
  - For `getLyrics` with only `artist` + `title`, treat this as a best-effort fallback:
    - search Jellyfin,  
    - try multiple candidates until one returns lyrics,  
    - still return a valid (possibly empty) lyrics response if nothing matches.

- **Synced lyrics**  
  - When Jellyfin exposes synced lyrics with timestamps, convert those to milliseconds and expose them via OpenSubsonic’s `lyricsList.structuredLyrics` format so clients like Musly can do proper karaoke/scrolling.

## Development validation workflow (mandatory)

Before considering any handler/mapper change complete, follow the **development validation workflow**: rebuild local container, capture credentials from `data/`, run client-mimic calls to local Subfin, verify responses against Jellyfin for content parity, remediate and repeat until known clients would succeed and Subfin data matches Jellyfin. Full process: **`.local-testing/README.md`** and the **subfin-development-validation** skill. **If credential validation fails:** prompt the user to re-create credentials for the test account; do not retry in a loop.

## General debugging workflow for compatibility

When a client misbehaves or crashes:

1. **Turn on REST logging**  
   - Enable `SUBFIN_LOG_REST` so you can see which methods are called and what keys are present in Subfin’s response payloads.

2. **Identify the failing endpoint and path**  
   - Watch the client’s stack trace for messages like “missing field X at path $.subsonic-response.<something>” and match that to the endpoint (`getAlbum`, `getPlaylist`, etc.).

3. **Inspect the client’s expectations**  
   - When possible, look up the client’s models (e.g. Navic’s `Track`/`Playlist` or DSub’s XML parsing) or the OpenSubsonic response docs to see which fields are assumed non-null or always present.

4. **Patch Subfin mappers, not Jellyfin**  
   - Keep Jellyfin access thin; add compatibility logic in Subfin’s mappers/handlers (e.g. `toSubsonicSong`, playlist mapping, artist info mapping).

5. **Add fields, don’t remove**  
   - Prefer adding compatibility fields rather than changing or removing existing ones, to avoid regressions in other clients.

6. **Verify in both JSON and XML**  
   - Test with at least one JSON-centric client and one XML-centric client whenever adding or changing fields.
7. **Optionally sanity-check via raw API calls**  
   - For quick spot-checks against the hosted Subfin/Jellyfin test instances (`https://subfin.kray.pw`, `https://jellyfin.kray.pw`), you can reuse the local testing credentials stored in `.local-testing/subfin-api-credentials.json` (git-ignored).
   - Use those credentials to hit specific OpenSubsonic endpoints with `curl` or a REST client when you want to confirm that a mapper or handler change behaves correctly without involving a full client app session.
   - **Credential source and validation:** See **`.local-testing/README.md`** and the **subfin-development-validation** skill. If credential validation fails, prompt the user to re-create credentials; do not loop.

## Examples

- **Fixing Navic track crashes**  
  - Problem: Navic’s `Track` model required `displayArtist`, `displayAlbumArtist`, and `displayComposer`; Subfin only sent `artist` and `album`.  
  - Fix: Extend `toSubsonicSong` to always populate these three fields, with sensible defaults, and keep `artist` in sync with `displayArtist`.

- **Fixing DSub artist info caption**  
  - Problem: DSub showed a placeholder caption (“This is the album title”) on the artist info screen.  
  - Fix: Ensure `getArtistInfo` provides a `name` field, and in XML, set both a `<name>` element and `name="..."` attribute on the root element so clients have a clear title/caption source.

- **Enabling playlist cover art in Navic and others**  
  - Problem: Clients couldn’t display playlist images because Subfin did not send `coverArt` for playlists.  
  - Fix: In both `getPlaylists` and `getPlaylist`, set `coverArt: "pl-<playlistId>"` and update `getCoverArt` to handle `pl-` ids (by stripping the prefix and using the Jellyfin playlist id).
 
## Client analysis directories

When investigating or extending compatibility for a specific client, also consult the per-client analysis folders at the repo root:

- `.youamp-analysis/` – full checkout of Youamp + its Subsonic API library.
- `.navic-analysis/ANALYSIS.md` – summary of Navic’s API usage and model assumptions, plus the Navic source tree under `.navic-analysis/`.
- `.musly-analysis/ANALYSIS.md` – summary of Musly’s API usage and model assumptions, plus the Musly source tree under `.musly-analysis/`.
- `.tempus-analysis/ANALYSIS.md` – summary of Tempus’s API usage and model assumptions, plus the Tempus source tree under `.tempus-analysis/`.
- `.castafiore-analysis/ANALYSIS.md` – summary of Castafiore’s API usage and model assumptions, plus the Castafiore source tree under `.castafiore-analysis/`.
- `.dsub2000-analysis/ANALYSIS.md` – summary of DSub2000’s API usage and model assumptions, plus the DSub2000 source tree under `.dsub2000-analysis/`.

Use these when:

- You change a mapper or handler and need to see how a client actually uses an endpoint (which fields are assumed non-null, which variants it calls, JSON vs XML).
- You are debugging a client-specific issue and want to confirm whether the client is relying on an OpenSubsonic extension (`search3`, `getLyricsBySongId`, `getSimilarSongs2`, etc.).
- You need to understand secondary behaviors (e.g. favorites, play queues, internet radio, jukebox) beyond what the OpenSubsonic spec alone describes.

When a change impacts a particular endpoint, skim the relevant client analysis (and, if needed, the corresponding code in that analysis tree) to verify that the new behavior remains compatible with that client’s expectations.