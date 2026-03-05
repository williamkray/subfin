---
name: subfin-compat-matrix
description: Keeps the OpenSubsonic compatibility matrix in subfin up to date by mapping implemented or changed middleware functionality to the correct OpenSubsonic endpoints and Jellyfin APIs. Use whenever the conversation confirms new endpoints, behaviors, or features as working (fully or partially), or when refactoring Subfin’s Subsonic/Jellyfin translation logic.
---

# Subfin OpenSubsonic Compatibility Matrix Maintenance

## When to use this skill

Use this skill in the **subfin** project whenever:

- A change **adds a new OpenSubsonic endpoint** or **extends an existing one**.
- You verify that an endpoint now **works end-to-end in a client** (e.g. DSub2000, Navidrome clients).
- You change how Subfin maps a Subsonic/OpenSubsonic endpoint to **Jellyfin APIs** (e.g. switching stream URLs, auth mechanisms, image endpoints).
- You are asked about **what’s implemented / missing** or about **coverage vs the OpenSubsonic spec**.

The goal is: **never let the README’s compatibility matrix drift out of sync** with the actual middleware behavior.

Relevant files:

- `[src/subsonic/router.ts](src/subsonic/router.ts)`
- `[src/subsonic/handlers.ts](src/subsonic/handlers.ts)`
- `[src/subsonic/mappers.ts](src/subsonic/mappers.ts)` – shared mappers for albums/songs/artists used across many endpoints.
- `[src/jellyfin/client.ts](src/jellyfin/client.ts)`
- `[README.md](README.md)` – especially the **Status** and **OpenSubsonic compatibility matrix** sections.

## Instructions

### 1. Identify the affected OpenSubsonic endpoint(s)

When work touches Subfin behavior, first determine which OpenSubsonic endpoint(s) are involved:

- Look at `method` handling in `subsonicRouter` in `src/subsonic/router.ts`:
  - The `HANDLERS` map keys (e.g. `getmusicfolders`, `getalbumlist`, `getartistinfo`) are the canonical OpenSubsonic method names (lowercased, `.view` stripped).
- Cross-check against the OpenSubsonic docs if needed for exact endpoint semantics.

Classify the change:

- **Newly implemented endpoint** – previously missing / unknown.
- **Endpoint upgraded** – e.g. stub → partial, partial → full.
- **Behavior change** – e.g. different Jellyfin URL, new parameters, or additional fields in responses.

### 2. Determine implementation status (Fully / Partially / Unimplemented)

For each affected endpoint:

1. **Scan implementation**:
   - In `src/subsonic/handlers.ts`, locate the corresponding `handleX` function.
   - In `src/jellyfin/client.ts`, check which Jellyfin APIs are used (e.g. `getMusicLibraries`, `getArtists`, universal audio stream).
2. **Decide status**:
   - **Fully implemented** when:
     - All core fields expected by typical Subsonic/OpenSubsonic clients are populated.
     - The endpoint is known to work in at least one real client (e.g. DSub2000, Youamp, Musly, Tempus) without errors.
   - **Partially implemented** when:
     - The endpoint exists and returns structurally valid responses, but omits significant behavior (e.g. playlists list without CRUD, empty artist biography, unsupported list types, missing favorites or play counts).
  - **Unimplemented** when:
    - There is no handler, or the router treats it as `Unknown method`, or the implementation is clearly a stub for a different purpose.
  - **Not planned** when:
    - The feature is explicitly out of scope (e.g. podcasts, internet radio, video playback/streaming, bookmarking). Use status **Not planned** and a short note that it is out of scope; see README “Out of scope (not planned)”.

Err on the side of **“Partially implemented”** instead of “Fully” if major aspects of the spec are not supported.

### 3. Map to Jellyfin APIs and note translation differences

For each endpoint you classify:

1. Identify the **Jellyfin API calls** involved:
   - Examples: `LibraryApi.getMediaFolders`, `ItemsApi.getItems`, Jellyfin universal audio `/Audio/{id}/universal`, `UserApi.getCurrentUser`, QuickConnect APIs, image endpoints.
2. Note key **translation details**:
   - **ID semantics**: Subsonic `id` vs Jellyfin `Id` (and prefixes like `ar-` / `al-` for cover art).
   - **Filters / sorts**: how Subsonic `type`, `size`, `offset`, or query params map to Jellyfin filters and sorting (e.g. random, newest, alphabetical).
   - **Auth**: whether the endpoint uses app passwords, token (`t`/`s`) auth, or `apiKey`, and how that maps to Jellyfin access tokens.
   - **Media format**: direct vs transcoded streaming, containers/codecs, bitrates, and whether you’re using universal audio vs direct `/Audio/{id}/stream`.
   - **Missing behaviors**: e.g. no support for videos, no starred items, no last.fm metadata, etc.

Keep explanations short but specific – the README matrix should remain concise.

### 4. Update the README compatibility matrix

When changes affect coverage, update `[README.md](README.md)`:

1. Find the **“OpenSubsonic compatibility matrix”** section.
2. Within the appropriate category table (System, Browsing, Album/songs, Search, Playlists, Media retrieval, Users, Podcasts/Radio/Sharing/Bookmarks/Chat), update or add the row:
   - **Endpoint** – exact OpenSubsonic name(s) (e.g. `` `getAlbumList` `` or `` `getArtistInfo` / `getArtistInfo2` ``).
   - **Status** – `**Fully implemented**`, `**Partially implemented**`, or `**Unimplemented**`.
   - **Jellyfin mapping** – concise description of Jellyfin APIs used or planned.
   - **Notes** – 1–2 sentences on translation details, limitations, or TODOs.
3. Also cross-check the high-level **Status** bullets above the matrix:
   - If an endpoint moves from “not implemented” to working, adjust the bullet lists (e.g. add to “Working” or narrow the “Not implemented / TODO” language).

Ensure consistency:

- If an endpoint is marked **Partially implemented** in the matrix, avoid calling it fully working in the Status section.
- If behavior regresses, update the matrix back to **Unimplemented** or **Partial** and note the caveat.

### 5. When multiple endpoints are affected

For larger refactors (e.g. adding playlists, search, or podcasts):

- Group updates by **category** (Playlists, Search, Podcasts).
- Update all relevant endpoints in one pass:
  - Example: implementing playlist listing should adjust `getPlaylists` status, and if you add `getPlaylist`, `createPlaylist`, `updatePlaylist`, update those rows in the same edit.

If the changes are very extensive, consider:

- Adding a brief summary bullet under `Status` (e.g. “Basic playlist listing implemented; CRUD still TODO”).

## Examples

### Example 1: New endpoint becomes partially implemented

- You add `handleGetArtistInfo` that returns an empty biography and no similar artists, just to prevent DSub from crashing.
- You then:
  - Classify `getArtistInfo` / `getArtistInfo2` as **Partially implemented**.
  - Set Jellyfin mapping to “N/A (would use last.fm or Jellyfin metadata)”.
  - Note that it returns structural data only and real metadata is still TODO.

### Example 2: Upgrading `stream` behavior

- You switch from a raw `/Audio/{id}/stream?ApiKey=...` URL to the universal audio `/Audio/{id}/universal` endpoint with proper `UserId` and bitrate.
- You then:
  - Confirm `stream` remains **Fully implemented (audio)**.
  - Update the Jellyfin mapping/Notes in the matrix to reference the universal endpoint and mention proxy and `maxBitRate` translation.

### Example 3: Implementing `getRandomSongs`

- You add `handleGetRandomSongs` which calls `ItemsApi.getItems` with `sortBy=Random`, `includeItemTypes=Audio`, and `limit`/`startIndex` from Subsonic params.
- You then:
  - Change `getRandomSongs` from **Unimplemented** to **Fully implemented** (or **Partially** if some filters are missing).
  - Document the Jellyfin mapping and any unsupported filters (e.g. missing year/genre constraints).

By following this skill whenever functionality changes, the README’s compatibility matrix will remain an accurate, low-friction reference for Subfin’s OpenSubsonic coverage and Jellyfin-specific translation details.

