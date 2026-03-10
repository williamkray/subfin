# Subfin

OpenSubsonic-to-Jellyfin compatibility layer. Use Subsonic/Navidrome clients (DSub, substreamer, etc.) with your existing Jellyfin music library.

>[!NOTE]
>This was written with AI in Cursor. If you don't like the future, don't use this. If you're ok with "AI Slop", give it a whirl. I am using it happily myself and have made every attempt to have it produce reasonably clean code without significant security issues. I did this because after all these years, nobody else did it, I have limited time and resources, and I just wanted something that would work. If you find something that can or should be fixed, PRs are very much welcome!

## How it works

- **Subsonic clients** point at Subfin using **host and port** (e.g. `http://your-server:4040`).
- You **link your Jellyfin account** via the Subfin web UI (Quick Connect). Subfin gives you an **app password** to use in the Subsonic client with your Jellyfin username. You can manage devices (rename, reset, unlink) and create or manage shared media (share links) from the web UI.
- Subfin translates OpenSubsonic API calls into Jellyfin API calls and returns Subsonic-shaped responses; stream, download, cover art, and avatar are proxied from Jellyfin.

## Requirements

- Node.js 20+
- A Jellyfin server with a music library
- **Quick Connect** enabled on your Jellyfin server (Jellyfin → Dashboard → Quick Connect). Required to link devices and obtain app passwords from the Subfin web UI.

## Setup

```bash
npm install   # may require build tools for better-sqlite3 (e.g. python, make, g++)
npm run build
```

## Configuration

Settings can come from **environment variables** or an optional **config file** (`subfin.config.json` by default, or path in `SUBFIN_CONFIG`). Env overrides the config file. Standalone instances can use either.

**Required:** `SUBFIN_SALT` — Secret used to encrypt sensitive data in the SQLite database. Set in config as `"salt"` or as env `SUBFIN_SALT`. Must be at least 32 bytes (e.g. 44-character base64). Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4040` | HTTP port |
| `JELLYFIN_URL` | `http://localhost:8096` | Jellyfin server URL |
| `JELLYFIN_CLIENT` | `Subfin` | Client name sent to Jellyfin |
| `JELLYFIN_DEVICE_ID` | `subfin-device-1` | Device ID |
| `MUSIC_LIBRARY_IDS` | (all) | Comma-separated library IDs or display names to expose (optional). Accepts Jellyfin view IDs (32-char hex, e.g. from the URL `topParentId=...` when opening a library in the web UI) or library names (e.g. `Contemporary Music`); names are matched case-insensitively. Names containing commas must use the ID. When set, **all** list endpoints (getMusicFolders, getArtists, getIndexes, getAlbumList, getRandomSongs, getGenres, getSongsByGenre) are restricted to these libraries when the client does not send a music folder. |
| `SUBFIN_DB_PATH` | `./subfin.db` | Path for the SQLite database (tokens and app passwords, encrypted at rest). If a legacy `subfin.json` exists at the same path with `.json` extension, it is migrated once to SQLite and renamed to `subfin.json.migrated`. |
| `SUBFIN_SALT` | *(required)* | Secret for DB encryption (see above). In config file: `"salt": "<base64 or hex>"`. |
| `SUBFIN_LOG_REST` | (off) | Set to `true` or `1` to log each REST request (method and auth) for debugging clients. Do not enable in production; logs may contain tokens. |
| `SUBFIN_PUBLIC_URL` | (empty) | Optional public URL of Subfin (e.g. `https://subfin.example.com`) for absolute image URLs in `getArtistInfo` / `getArtistInfo2` and used when generating Share links. |
| `SUBFIN_CONFIG` | `subfin.config.json` | Path to JSON config file (optional). All settings above can be in this file; env overrides. |

## Run

```bash
npm start
```

## Docker

Build and run with a volume for persistent storage (app passwords and tokens):

```bash
docker build -t subfin .
docker run -d --name subfin -p 4040:4040 -v subfin-data:/data -e JELLYFIN_URL=https://your-jellyfin.example.com subfin
```

- **Port:** `4040` is exposed; map it (e.g. `-p 4040:4040`) or use a reverse proxy.
- **Volume:** Mount a volume at `/data` so the SQLite DB and optional config persist (e.g. `-v subfin-data:/data`).
- **Config:** Set `SUBFIN_SALT` (required) and override with env vars (`-e JELLYFIN_URL=...`, `-e SUBFIN_SALT=...`, etc.).

The container runs as a non-root user and expects writable `/data` for the store.

**Jellyfin activity panel (device & IP):** Each linked device appears in Jellyfin under its label (or “Subfin Device &lt;id&gt;”). Subfin sends the client’s IP on outbound requests via `X-Forwarded-For` (using the first value from the incoming request’s `X-Forwarded-For` or `X-Real-IP`, or the socket address). For that IP to show in Jellyfin’s activity panel, add Subfin’s IP (or your reverse proxy’s IP) to **Jellyfin → Dashboard → Network → Known Proxies**.

- **Subsonic clients:** Configure with base URL only, e.g. `http://localhost:4040` (no `/rest` path).
- **Web UI:** `http://localhost:4040/` (link device, manage devices). REST API is at `/rest/` (e.g. `/rest/ping.view`).

## Web UI

Quick Connect must be enabled on your Jellyfin server. The web UI is where you link devices and get app passwords.

1. **Link a device** (`/link`): Sign in with Jellyfin via **Quick Connect**. Subfin shows a one-time **app password** — use it with your **Jellyfin username** in the Subsonic client for that device.
2. **Manage devices** (`/devices`): Sign in with Subsonic username + app password to list linked devices, rename them, **reset password**, or **unlink**. You can also create and manage **share links** (playlist/album shares) from the same page.

## Subsonic client setup

- **Server URL:** `http://your-subfin-host:4040` (or `https://...` if behind TLS). Use the base URL only (no `/rest` path); the client adds `/rest/` itself (e.g. DSub builds `.../rest/ping.view`).
- **Username:** Your Jellyfin username (same as when you linked the device).
- **Password:** The app password from the Subfin link page (or after a reset). Obtain it by linking the device in the Subfin web UI first.

Subfin supports standard Subsonic auth: password (`p`, including `enc:`), token auth (`t`/`s`), and `apiKey` (all mapped to the app password).

**Legacy auth vs token auth (client setting):** Many clients have a “use legacy auth” or “token authentication” option. In the Subsonic/OpenSubsonic API, **token auth** means the client sends a one-way hash of your password plus a salt (`t` and `s`) instead of the password itself—more secure and the recommended default. **Legacy auth** means the client sends your actual password (`p`) with each request. Subfin can only use your **Jellyfin password** when the client sends it (legacy auth). With token auth, Subfin never sees the password, so it cannot log you in with Jellyfin unless it already has a stored app password for that client. So: to use your Jellyfin password directly in the client you must turn **on** “use legacy auth” (or turn **off** “token authentication”); to keep token auth and avoid sending your Jellyfin password, link the device once in the Subfin web UI and use the **app password** in the client—then token auth works because Subfin stores and verifies that app password.

REST responses default to **XML** when the client does not send `f=` (Subsonic API default; required for DSub and similar clients).

**Lyrics: API behavior and client consistency**

Subfin exposes two lyrics endpoints:

| Endpoint | Parameters | How Subfin resolves the track | Typical client |
|----------|------------|-------------------------------|----------------|
| **getLyrics** | `artist`, `title` (optional in spec) or **`id`** (Subfin extension) | If `id` is sent → direct lookup by track id. If only `artist`+`title` → Jellyfin **search**; if search returns 0, Subfin tries an **artist+title fallback** (resolve artist by name, list that artist's tracks, filter by title). | **Tempus** often sends only `artist` and `title` (no `id`), so resolution depends on search; when Jellyfin search finds nothing, you see “no itemId” and empty lyrics. |
| **getLyricsBySongId** | **`id`** (required) | Direct lookup by track id; no search. | **Musly** uses this (or getLyrics with `id`), so lyrics match the playing track and work reliably. |

**Why Tempus can miss lyrics while Musly shows them:** Tempus calls **getLyrics** with only **artist** and **title**. Subfin then runs a Jellyfin search for that string; if the search returns no items (e.g. “Ghost Call Me Little Sunshine” returns 0 results), there is no track id and lyrics stay empty. Musly calls **getLyricsBySongId** (or getLyrics with **id**) using the **current track id**, so Subfin fetches lyrics for that exact item without search.

**Recommendation for consistency:** When the client has the current track id (e.g. from stream, now playing, or play queue), it should request lyrics by id: either **getLyricsBySongId?id=...** (OpenSubsonic) or **getLyrics?id=...** (Subfin accepts `id` in getLyrics). That avoids search and matches Musly’s reliable behavior. Using only artist+title is a fallback and can fail when Jellyfin search returns no or wrong results.

- **Tempus**: When getLyrics is called with only artist+title, Subfin first tries full-text search; if that returns 0 results, it uses an **artist+title fallback** (resolve artist by name → list that artist's tracks → filter by title) so lyrics can still be found. Sending track `id` when available remains the most reliable option.
- **Musly**: If scrolling or navigating the lyrics view causes the play queue to jump, that is likely a client bug; consider reporting to the Musly project.

## Status

### Working

- **Auth & linking**
  - Jellyfin linking via **Quick Connect** in the Subfin web UI. Per-device app passwords; device management (rename, reset, unlink); share links. App passwords stored per Subsonic username/device.
  - Subsonic auth via `u` + `p` (including `enc:` format), `t` + `s` token auth, or `apiKey`.
- **Core browsing**
  - `ping`, `getLicense`
  - `getMusicFolders`, `getIndexes`
  - `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getMusicDirectory`
  - `getAlbumList` for home/album lists
- **Playback**
  - `stream` using Jellyfin's **universal audio** endpoint, proxied from Jellyfin to the client.
  - Tested end-to-end with **DSub2000** (browse → play → cache).
- **Artwork & metadata**
  - `getCoverArt` mapped to Jellyfin images for artists, albums, and songs.
  - `getArtistInfo` / `getArtistInfo2`: biography from Jellyfin Overview, MusicBrainz id from ProviderIds, similar artists from Jellyfin; optional `SUBFIN_PUBLIC_URL` for artist image URLs.
- **User / playlists**
  - `getUser`, `getUsers` return the current Subsonic user.
  - `getPlaylists` / `getPlaylist`: list and open playlists; `createPlaylist`, `updatePlaylist`, `deletePlaylist` for own playlists (shared playlists are read-only).
- **Lyrics**
  - `getLyrics` (by track `id` or by `artist`+`title`): returns plain lyrics from Jellyfin; when only artist+title is sent, Subfin tries multiple search results until one has lyrics (helps clients like Tempus).
  - `getLyricsBySongId` (OpenSubsonic): returns `lyricsList` with `structuredLyrics` (synced/unsynced lines).
- **Starring & ratings**
  - `getStarred` / `getStarred2`: return starred artists, albums, and songs from Jellyfin (OpenSubsonic shape: `starred2.artist`, `starred2.album`, `starred2.song`).
  - `star` / `unstar`: mark or clear favorites in Jellyfin (supports id, albumId, artistId, idList).
  - `setRating`: map Subsonic rating to Jellyfin like (4–5 like, 1–2 unlike, 3 clear). Jellyfin does not support 1–5 star ratings; “highest rated” album lists are based on likes/favorites rather than a continuous rating scale.

### Not implemented / TODO

- Richer **artist/album metadata** (e.g. Last.fm links; biographies and similar artists already come from Jellyfin).
- Playlist CRUD is implemented; remaining work is client testing and any Jellyfin permission edge cases.
- Further **search / discovery** refinements (e.g. full filter semantics for `getRandomSongs`, multi-genre/year for `getSongsByGenre`).
- **Scrobbling** refinement (e.g. pause/resume precision) and other write APIs (play queue save).
- More complete **error handling and diagnostics** around Jellyfin failures and network issues.
- Configuration UI and docs for **transcoding / bitrate** and multi-library setups.

### Out of scope (not planned)

The following are **not prioritized or planned** for Subfin. The project focuses on **music** (browse, stream, playlists, lyrics, favorites). No work is intended for:

- **Podcasts** — no podcast endpoints or Jellyfin podcast mapping.
- **Internet radio** — no radio station endpoints or Live TV mapping.
- **Video playback or streaming** — no video endpoints; `stream` / `download` are audio-only. `getVideos` / `getVideoInfo` will not be implemented.
- **Bookmarking** — no bookmark endpoints (e.g. `createBookmark`, `getBookmarks`, `deleteBookmark`).
- **tokenInfo** — no API to expose app-password / API key metadata from Subfin's store.
- **User management** — no `createUser` / `updateUser` / `deleteUser` / `changePassword`; Jellyfin user management stays in Jellyfin.
- **Chat** — no `addChatMessage` / `getChatMessages`; no Jellyfin equivalent and not in scope.

If a client calls these APIs, Subfin will return “Unknown method” or an equivalent error.

## OpenSubsonic compatibility matrix

High-level mapping of OpenSubsonic endpoints to Jellyfin APIs and current Subfin implementation status.

### System

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `ping` | **Fully implemented** | N/A (internal health) | Returns a standard Subsonic `subsonic-response` without calling Jellyfin. |
| `getLicense` | **Fully implemented** | N/A | Always reports a valid license; Jellyfin has no license concept. |
| `getOpenSubsonicExtensions` | **Partially implemented** | N/A | Returns a static list of supported extensions (transcoders, formats, lyrics). |
| `tokenInfo` | **Not planned** | — | Out of scope; no API to expose app-password metadata from Subfin's store. |

### Browsing (library and metadata)

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `getMusicFolders` | **Fully implemented** | `UserViewsApi.getUserViews(userId)` (filter `CollectionType=Music`) | Returns user-visible music libraries; respects `MUSIC_LIBRARY_IDS`. Uses UserViews because `Library/MediaFolders` returns 403 for non-admin users. |
| `getIndexes` | **Fully implemented** | `ItemsApi.getItems(includeItemTypes=MusicArtist)` | Builds letter indexes from Jellyfin artists; stores `ignoredArticles` locally. |
| `getMusicDirectory` | **Fully implemented (music)** | `ItemsApi.getItems` (album or artist) | Treats `id` as album or artist (strips `ar-`/`al-`/`pl-`); returns albums or songs accordingly. |
| `getGenres` | **Partially implemented** | `GenresApi.getGenres` | Uses Jellyfin’s genres API to list distinct text genres with song/album counts; semantics follow Jellyfin’s tagging model, so composite/untidy genre strings are surfaced as-is. |
| `getArtists` / `getArtist` | **Fully implemented** | `ItemsApi.getItems(MusicArtist)` | Lists and fetches Jellyfin `MusicArtist` items; accepts `ar-`-prefixed ids (stripped before Jellyfin). |
| `getAlbum` | **Fully implemented** | `ItemsApi.getItems(MusicAlbum)` + `ItemsApi.getItems(Audio)` | Maps a Jellyfin album and its tracks; accepts `al-`-prefixed ids. Songs include `artistId`/`albumId` for "go to artist/album". |
| `getSong` | **Fully implemented** | `ItemsApi.getItems(Audio)` | Maps a single Jellyfin audio item to a Subsonic `child`/song; id prefix stripped when present. |
| `getVideos` / `getVideoInfo` | **Not planned** | — | Video is out of scope; Subfin is music-only. |
| `getArtistInfo` / `getArtistInfo2` | **Partially implemented** | Jellyfin `ItemsApi.getItems` (Overview, ProviderIds) + `LibraryApi.getSimilarArtists` | Biography from Jellyfin Overview, MusicBrainz id from ProviderIds, similar artists from Jellyfin `/Artists/{id}/Similar`. Optional `SUBFIN_PUBLIC_URL` for artist image URLs. |
| `getAlbumInfo` / `getAlbumInfo2` | **Unimplemented** | N/A / potential external metadata | Would return album notes / extended metadata (likely from last.fm or Jellyfin plugins). |

### Album / song lists

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `getAlbumList` | **Fully implemented** | `ItemsApi.getItems(MusicAlbum)` + Audio for recent/frequent; `/Users/{id}/Items` with Filters=IsFavoriteOrLikes for highest | Album/ID3-based album lists over Jellyfin libraries; supports types: random, newest, **recent**, **frequent**, **starred**, **highest** (based on likes/favorites), alphabeticalByName/ByArtist, byGenre, byYear. Jellyfin has no folder-based album lists or 1–5 star ratings, so legacy Subsonic folder semantics and rating-based ordering do not apply. |
| `getAlbumList2` | **Fully implemented** | `ItemsApi.getItems(MusicAlbum)` | Same data as `getAlbumList`, exposed as both `<albumList>` and `<albumList2>` for compatibility. Additional folder-vs-ID3 distinctions from legacy Subsonic servers are out of scope because Jellyfin only exposes album/ID3-based libraries. |
| `getRandomSongs` | **Partially implemented** | `ItemsApi.getItems(sortBy=Random, includeItemTypes=Audio)` | Returns random audio tracks via Jellyfin’s random sort; supports `size`, `offset`, optional `musicFolderId`, and `genre` (mapped to Jellyfin text genres); currently ignores year and other advanced filters. |
| `getSongsByGenre` | **Partially implemented** | `ItemsApi.getItems(Audio, genres=...)` | Filters audio items by a single genre with paging; currently uses Jellyfin text genres and doesn’t yet implement multi-genre or year/artist scoping. |
| `getNowPlaying` | **Partially implemented** | Jellyfin `SessionApi.getSessions` | Reads active Jellyfin sessions for the current user and exposes audio `NowPlayingItem`s as Subsonic `nowPlaying` entries; does not yet aggregate across all users or support rich player state, and play/pause is inferred from sparse Subsonic scrobbles so Jellyfin’s dashboard may slightly overestimate play time when clients are paused. |
| `getStarred` / `getStarred2` | **Fully implemented** | `ItemsApi.getItems(isFavorite=true)` for MusicArtist, MusicAlbum, Audio | Returns starred artists, albums, and songs; response shape matches OpenSubsonic. Safe fallbacks for id/name/artist/created and album field (Youamp); full song fields (Musly). XML includes coverArt, albumCount, created, songCount. |
| `star` / `unstar` / `setRating` | **Fully implemented** | Jellyfin `UserLibraryApi.markFavorite`, `unmarkFavorite`, `setUserLikeForItem` | Star/unstar mark items as favorite in Jellyfin (supports id, albumId, artistId, idList). setRating maps rating to Jellyfin like (4–5 like, 1–2 unlike, 3 clear). |
| `getTopSongs` | **Partially implemented** | `ItemsApi.getItems(Audio, artistIds=..., sortBy=PlayCount)` | Returns top songs for a given artist by mapping the artist name to a Jellyfin `MusicArtist` and fetching that artist’s audio items sorted by play count; uses Jellyfin’s play statistics instead of external Last.fm data and may differ from Subsonic’s Last.fm-based rankings. |
| `getSimilarSongs` / `getSimilarSongs2` | **Fully implemented** | Jellyfin `InstantMixApi` (artist/album/item instant mix) | Instant mix / artist radio backed by Jellyfin’s instant mix APIs (and any installed plugins). Accepts artist (`ar-*` or raw artist id), album (`al-*`), or song id and returns Jellyfin’s recommended similar songs. Subfin does not add extra recommendation logic beyond Jellyfin/Instant Mix; further behavior changes should be made in Jellyfin or its plugins, not in Subfin. |

### Search

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `search` / `search2` / `search3` | **Partially implemented** | Jellyfin search APIs (`ItemsApi` with `searchTerm`) | `search3` is implemented and powers all three endpoints, returning artists, albums, and songs via Jellyfin’s text search; some advanced filters and ID3-specific behaviors are not yet supported. |

### Playlists

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `getPlaylists` | **Fully implemented** | `ItemsApi.getItems(Playlist)` | Lists Jellyfin playlists visible to the current user; exposes basic metadata (id, name, owner, songCount, created/changed, duration). |
| `getPlaylist` | **Fully implemented** | Jellyfin `/Playlists/{id}/Items` | Returns playlist entries as Subsonic `<entry>` elements backed by the playlist’s Jellyfin audio items. |
| `createPlaylist` | **Fully implemented** | Jellyfin `PlaylistsApi.createPlaylist` | Creates a new playlist (name, optional initial songIds). If `playlistId` is provided, overwrites that playlist's name and items. |
| `updatePlaylist` | **Fully implemented** | Jellyfin `addItemToPlaylist` / `removeItemFromPlaylist` / `updatePlaylist` | Rename, add songs (`songIdToAdd`), remove by index (`songIndexToRemove`). Shared/read-only playlists return an error. |
| `deletePlaylist` | **Fully implemented** | Jellyfin `DELETE /Items/{id}` | Deletes a playlist; shared playlists return an error. |

### Media retrieval

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `stream` | **Fully implemented (audio)** | Jellyfin universal audio (`/Audio/{id}/universal`) | Proxied from Jellyfin with proper `UserId`/`DeviceId` and bitrate; respects `maxBitRate` where provided. |
| `download` | **Partially implemented (audio)** | Jellyfin audio stream (`/Audio/{id}/stream`) with `Static=true` | Proxied from Jellyfin for original audio files. HLS, video, and advanced transcoding controls are not yet exposed. |
| `hls` / `getTranscodeStream` | **Not planned** | — | Out of scope. HLS is commonly used for video; for audio, streaming and bitrate control are already covered by `stream` (Jellyfin universal audio, `maxBitRate`). Explicit HLS/transcode endpoints are not planned. |
| `getCoverArt` | **Fully implemented** | `Items/{id}/Images/Primary` | Maps Subsonic `coverArt` IDs (`ar-`, `al-`, or raw) to Jellyfin item IDs; proxied from Jellyfin. |
| `getLyrics` | **Partially implemented** | Jellyfin `/Audio/{itemId}/Lyrics` | Resolves by `id` or `artist`+`title`; when only artist+title is sent, tries multiple search results until one has lyrics. Returns `lyrics.artist`, `lyrics.title`, `lyrics.value`. |
| `getLyricsBySongId` | **Partially implemented** | Same lyrics API | OpenSubsonic; takes track `id`, returns `lyricsList.structuredLyrics` (synced/unsynced lines). |
| `getAvatar` | **Partially implemented** | `Users/{userId}/Images/Primary` | Returns the authenticated user's Jellyfin avatar (optional `username` must match); proxied from Jellyfin. |
| `downloadPodcastEpisode` / other podcast media retrieval | **Not planned** | — | Podcasts are out of scope; Subfin is music-only. |

### Users and security

| Endpoint | Status | Jellyfin mapping | Notes |
|---------|--------|------------------|-------|
| `getUser` / `getUsers` | **Partially implemented** | `UserApi.getCurrentUser` / `UserApi.getUsers` | Returns only basic user info (username, email empty); roles, folder access, and admin flags are not yet exposed. |
| `createUser` / `updateUser` / `deleteUser` / `changePassword` | **Not planned** | — | Out of scope; Jellyfin user management stays in Jellyfin. |

### Podcasts, radio, sharing, bookmarks, chat, and misc.

**Not planned (out of scope):** Podcasts, internet radio, video playback/streaming, and bookmarking are **not prioritized or planned** — see [Out of scope (not planned)](#out-of-scope-not-planned) above.

Most of the remaining items below are **currently unimplemented** (exceptions: `savePlayQueue`, `getPlayQueue`, `scrobble`, `setRating`, `star`, `unstar` — see Playback state). Conceptually, the rest would be mapped as follows:

- **Podcasts** *(not planned)*: `getPodcasts`, `getPodcastEpisode`, etc. — no implementation intended.
- **Internet radio** *(not planned)*: `getInternetRadioStations`, create/update/delete — no implementation intended.
- **Sharing**: `createShare`, `getShares`, `updateShare`, `deleteShare` → Jellyfin sharing or a Subfin-managed public URL layer.
- **Bookmarks** *(not planned)*: `createBookmark`, `getBookmarks`, `deleteBookmark` — no implementation intended.
- **Chat** *(not planned)*: `addChatMessage`, `getChatMessages` — no implementation intended.
- **Playback state**: `savePlayQueue`, `savePlayQueueByIndex`, `getPlayQueue`, `getPlayQueueByIndex`, `scrobble`, `setRating`, `star`, `unstar` → Jellyfin play queue, playback reporting, and rating/favorite APIs.
  - **`savePlayQueue`** and **`getPlayQueue`** are **fully implemented**: Subfin stores one play queue per user (in SQLite). Clients save the queue as a list of **entry IDs** (track ids), plus the current track id and position in ms, and restore it on any device for cross-device continuity. Call `savePlayQueue` with no parameters to clear the saved queue.
  - **`savePlayQueueByIndex`** / **`getPlayQueueByIndex`** are **not yet implemented**. The “index” here is the **0-based position in the queue** (e.g. index 0 = first track, index 2 = third track). So instead of saving/restoring by entry id, the client would save “current index 3” and an ordered list of entries; some clients prefer this when they think in terms of “position in list” rather than ids. Same underlying play-queue feature, alternative API. Not yet wired in Subfin.
  - `scrobble` is wired to Jellyfin’s playstate API (start/progress/stop) using Subsonic scrobbles as coarse-grained signals; we intentionally **do not** infer playback from raw `stream` calls to avoid treating pre-fetched (gapless) streams as “now playing”. For Jellyfin’s “now playing” and dashboard to update **as soon as** a new track starts (e.g. when the queue auto-advances), the client should send **scrobble with `submission=false`** when that track actually starts, not only when it ends (`submission=true`). Otherwise Subfin only reports the track when it receives the end-of-track scrobble, so the dashboard updates late. Pause/resume still cannot be tracked precisely, so Jellyfin’s notion of elapsed time is approximate.
  - `setRating`, `star`, and `unstar` are **fully implemented**: they call Jellyfin’s favorite and user-like APIs (`markFavorite`, `unmarkFavorite`, `setUserLikeForItem`), so favorites and likes stay in sync with Jellyfin.
- **Library scanning / transcoding**: `startScan`, `getScanStatus`, `getTranscodeDecision` → Jellyfin library scan and transcoding APIs (not yet surfaced by Subfin).

## Token store

Subfin uses an **SQLite database** (path from `SUBFIN_DB_PATH`, default `./subfin.db`) for linked devices and app passwords. Sensitive columns are encrypted at rest using the key derived from `SUBFIN_SALT`. The build requires native tooling for **better-sqlite3** (e.g. Python, make, g++). If a legacy `subfin.json` file exists at the same path (with `.json` instead of `.db`), it is migrated once into SQLite and the old file is renamed to `subfin.json.migrated`.

## Security audit

Security findings from full codebase reviews are documented in **SECURITY-AUDIT.md** at the repo root. That report is generated by the Cursor **security-review** skill (run a “full security review” or “security audit” to update it).

## License

MIT
