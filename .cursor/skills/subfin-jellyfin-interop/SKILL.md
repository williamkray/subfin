---
name: subfin-jellyfin-interop
description: Captures integration patterns and pitfalls when translating OpenSubsonic requests to Jellyfin using the Subfin middleware, including auth handling, streaming, cover art, playlist behavior, and DSub2000-specific expectations. Use when adding new endpoints, adjusting Jellyfin calls, or debugging client issues to avoid regressions already discovered.
---

# Subfin Jellyfin–OpenSubsonic Interop Guide

This skill records the main lessons learned while making Subfin work with Jellyfin and real Subsonic/OpenSubsonic clients (especially DSub2000, Youamp, Musly, and Tempus). Use it as a checklist whenever you:

- Implement or change a Subsonic/OpenSubsonic endpoint.
- Touch Jellyfin streaming or image URLs.
- Adjust authentication or token behavior.
- Debug DSub2000 crashes or “connection failure” errors.

## 1. Authentication patterns

### 1.1 Subsonic side (clients)

- Clients authenticate with:
  - `u` (username) + `p` (password or `enc:` password), **or**
  - `u` + `t` + `s` (token auth), **or**
  - `u` + `apiKey`.
- In Subfin:
  - Treat all three (`p`, `t`+`s`, `apiKey`) as ways to supply the **app-specific password**.
  - Resolve `(username, appPassword)` via the JSON store (`resolveToJellyfinToken`) to get `jellyfinUserId` + `jellyfinAccessToken`.

**Key points:**

- Token auth (`t`/`s`) must be implemented by recomputing `md5(appPassword + s)` against stored **plain** app passwords for that user.
- Do **not** assume clients will always send `p` – DSub2000 will switch to tokens once it sees a compatible server.

### 1.2 Jellyfin side

- Always use the SDK’s `createApi` to build an `Api` instance:

  ```ts
  const api = createJellyfinApi(accessToken);
  ```

- This ensures:
  - The `Authorization` header is set as:

    ```text
    MediaBrowser Client="Subfin", Device="Subfin Middleware",
    DeviceId="...", Version="0.1.0", Token="<accessToken>"
    ```

  - Generated clients (`getLibraryApi`, `getItemsApi`, `getUserApi`, QuickConnect APIs, etc.) inherit proper auth.

- **When calling raw endpoints with `axiosInstance`** (e.g. `/Playlists/{id}/Items`):
  - You must **explicitly** pass the `Authorization` header; otherwise Jellyfin will challenge `CustomAuthentication` and respond 401.

  ```ts
  const authHeader = buildJellyfinAuthHeader(accessToken);
  const url = api.getUri(`/Playlists/${playlistId}/Items`, { UserId: userId });
  const response = await api.axiosInstance.get(url, {
    headers: { Authorization: authHeader },
  });
  ```

### 1.3 Token invalidation behavior

- **Subfin does NOT invalidate tokens on Jellyfin 401.** The REST router explicitly avoids calling `invalidateTokensForJellyfinUser` on 401, because by the time we call Jellyfin, Subfin auth has already succeeded—a 401 is usually Jellyfin rejecting the request (e.g. forbidden for shared playlist), not “bad credentials”. Invalidating would wipe all linked devices for that user incorrectly. So do **not** add 401-triggered invalidation without an explicit product decision.
- `invalidateTokensForJellyfinUser` exists in the store but is **never called** from any handler. If you need to revoke access, do it via the web UI (unlink device / reset app password).
- Before blaming auth loss on logic bugs, **first look for Jellyfin 401s** and expired/revoked Jellyfin tokens. When adding new Jellyfin calls, always send the correct `Authorization` header so we don’t cause unnecessary 401s.

## 2. Streaming and media URLs

### 2.1 Audio streaming (`stream`)

- Prefer Jellyfin’s **universal audio endpoint**:

  ```ts
  /Audio/{id}/universal
  ```

  with query parameters:

  - `UserId` – the Jellyfin user ID from the app-password mapping.
  - `DeviceId` – stable device ID from config.
  - `Container=mp3`, `AudioCodec=mp3`.
  - `MaxStreamingBitrate` – from Subsonic `maxBitRate` Kbps (×1000), defaulting to a sensible value (e.g. 320000).

- Subfin **proxies** the response from this URL to the client, preserving `Range` headers and streaming the body (no redirect mode).

### 2.2 Cover art

- Subsonic `coverArt` IDs are often namespaced:
  - `ar-<id>` – artist
  - `al-<id>` – album
  - `pl-<id>` – playlist

- Subfin must:
  - Strip the prefix before calling Jellyfin images:

    ```ts
    if (id.startsWith("ar-") || id.startsWith("al-") || id.startsWith("pl-")) {
      jellyfinId = id.slice(3);
    }
    ```

  - Use:

    ```ts
    /Items/{jellyfinId}/Images/Primary
    ```

    with optional `maxHeight`/`maxWidth=size` and `ApiKey` or `Authorization`.

- Subfin proxies cover art from Jellyfin; clients receive the image response from Subfin (no redirect).

## 3. Data shape expectations for DSub2000

DSub2000 parses XML responses and maps them into Java domain objects that frequently assume **non-null integers** and specific element/attribute names. To avoid client crashes:

### 3.1 Non-null integer fields

- For song/entry data (used in playlists, directories, random songs, etc.), **never leave critical integers null**:

  - `track` – default to `0` when `IndexNumber` is missing.
  - `discNumber` – default to `1` when `ParentIndexNumber` is missing.
  - `duration` – always numeric (0+ seconds).
  - `bitRate` – default to `0` when unknown.

- Centralize this in `toSubsonicSong` so all callers (album songs, playlists, random songs, etc.) benefit.

### 3.2 XML shapes per endpoint

- For key endpoints (those DSub uses heavily), **do not rely solely on generic JSON→XML conversion**. Instead, craft XML to match the Subsonic spec and DSub’s parsers:

  - `getIndexes` → `<indexes>` with `<index>` and `<artist>` elements.
  - `getAlbumList` → `<albumList>` with `<album>` elements.
  - `getMusicDirectory` → `<musicDirectory>` with `<child>` elements.
  - `getRandomSongs` → `<randomSongs>` with `<song>` elements.
  - `getPlaylists` → `<playlists>` with `<playlist id=... name=... owner=... songCount=... created=... changed=... duration=.../>`.
  - `getPlaylist` → `<playlist id=... name=...>` containing multiple `<entry .../>` elements.
  - `getArtistInfo` → `<artistInfo>` with `<biography>`, `<musicBrainzId>`, `<lastFmUrl>`, `<largeImageUrl>`, `<similarArtist .../>`.

- When adding or changing an endpoint, always cross-check the corresponding parser in DSub2000 (or another reference client) to verify:
  - Element names are correct.
  - Required attributes are present and non-null.
  - The nesting structure matches expectations.

## 4. Playlists: mapping and pitfalls

### 4.1 Listing playlists (`getPlaylists`)

- Use `ItemsApi.getItems` with `includeItemTypes=[Playlist]` to list playlists visible to the user.
- Map Jellyfin playlist properties to Subsonic:

  - `id` → `Id`
  - `name` → `Name`
  - `owner` → `UserId` or current Subsonic username
  - `songCount` → `ChildCount`
  - `created` → `DateCreated`
  - `changed` → `DateLastModified`
  - `duration` → `RunTimeTicks` converted to seconds

- Ensure the XML `<playlist>` elements include at least: `id`, `name`, `songCount`, `created`, `changed`, `duration`; `owner` and `comment` are optional but useful.

### 4.2 Viewing a playlist (`getPlaylist`)

- Use `/Playlists/{id}/Items` with:
  - `UserId` query parameter.
  - Proper `Authorization` header.
- Map each returned item to Subsonic `<entry>` via `toSubsonicSong`.
- Ensure:
  - All integer fields (`track`, `discNumber`, `duration`, `bitRate`) are non-null.
  - `path`, `album`, `artist` are present enough for DSub’s UI to function.

If you see DSub exceptions like `Attempt to invoke virtual method 'int java.lang.Integer.intValue()' on a null object reference`, revisit your integer defaults and XML attributes for the relevant endpoint.

## 5. Development validation workflow (mandatory)

For any change to endpoints or Jellyfin integration, follow the **development validation workflow** so that: (1) the local container is rebuilt and run with correct volumes/vars, (2) credentials are captured from `data/`, (3) client-mimic calls are run against local Subfin and responses captured, (4) results are verified against Jellyfin directly for content parity, (5) issues are remediated and the loop repeated until known clients would succeed and Subfin data matches Jellyfin. Full steps and commands: **`.local-testing/README.md`** and the **subfin-development-validation** skill. **If credential validation fails:** prompt the user to re-create credentials for the test account (e.g. re-link device); do not retry in a loop—the user will perform the required steps.

## 6. Debugging workflow

When something breaks (connection failure, crash, missing data):

1. **Check Subfin logs**:
   - Look for `[REST]` lines to see which endpoint the client called.
   - Look for `[STREAM]`, `[STREAM_PROXY]`, `[STREAM_PROXY_BYTES]`, `[COVER]` for streaming/image issues.
   - Look for backend 401s (Subfin does not invalidate tokens on 401; see §1.3).
2. **Check Jellyfin logs**:
   - `CustomAuthentication was challenged.` or 401s indicate missing/incorrect auth headers.
3. **Check the client’s parser**:
   - For DSub2000, locate the relevant `*Parser` class (e.g. `PlaylistParser`, `RandomSongsParser`, `ArtistInfoParser`) and verify your XML matches its expectations.
4. **Optionally reproduce via raw API calls**
   - For quick manual checks against the hosted test instances (`https://subfin.kray.pw`, `https://jellyfin.kray.pw`), you can use the local testing credentials stored in `.local-testing/subfin-api-credentials.json` (git-ignored).
   - Use those values with tools like `curl`, `httpie`, or REST clients to:
     - Call Subsonic/OpenSubsonic endpoints on `https://subfin.kray.pw` with `u` and `p`/`t`/`s` params using the known app password.
     - Call Jellyfin APIs on `https://jellyfin.kray.pw` by setting the `Authorization` header (e.g. `MediaBrowser Token="..."` or via `buildJellyfinAuthHeader`) with the stored `jellyfin_access_token`.
   - **Extracting and validating credentials:** See **`.local-testing/README.md`** and the **subfin-development-validation** skill for the full process. If credential validation fails, prompt the user to re-create credentials; do not loop.

Use this skill as a mental checklist before and after changes to ensure new endpoints and refactors preserve the hard-earned interop behaviors between OpenSubsonic clients and Jellyfin.

## 7. Client-specific quirks (beyond DSub)

### 6.1 Youamp

- **JSON-only:** Always uses `f=json` and expects a `subsonic-response` wrapper. XML responses are never parsed.
- **Strict non-null models:** Many fields are non-nullable in its Kotlin models. If Subfin omits them, Youamp will show “Oops, something went wrong” even if the response is spec-legal:
  - For **albums** (from `getAlbumList2`, `getAlbum`, `getStarred2`), ensure:
    - `id`, `artist`, and `created` are always present.
    - At least one of `name` or `album` is set.
  - For **songs** in lists such as `randomSongs`, `starred2`, and playlists:
    - Always provide `id`, `title`, `suffix`, `contentType`, and `size` (we currently default `suffix` to `"mp3"`, `contentType` to `"audio/mp3"`, `size` to `0`).
  - For **playlists**:
    - `getPlaylists` and `getPlaylist` must expose playlist headers with `id`, `name`, `owner`, `created`, `duration`, and `songCount`.
    - Use defaults where Jellyfin is missing values (e.g., `created` fallback to epoch, `duration` fallback to `0`).
- **Album list vs album list 2:**
  - Youamp only uses `getAlbumList2`, not `getAlbumList`.
  - Subfin should return both `albumList` **and** `albumList2` in JSON for `getAlbumList2` so:
    - Existing XML serializer (which reads `albumList`) continues to work.
    - JSON clients see `albumList2.album[]` as expected.
- **Favorites:**
  - Only `getStarred2` is used; `getStarred` is ignored.
  - `star` / `unstar` must be implemented (even as simple 200 responses) and `getStarred2` must reflect the change.
  - Subfin’s getStarred2 returns `artist[]`, `album[]`, `song[]` with safe fallbacks: albums have `id`, `name`, `album` (same as name), `artist`, `created`, `artistId`, `coverArt`, `songCount`; songs use `toSubsonicSong` (id, title, suffix, contentType, size, etc.); artists have `id`, `name`, `coverArt`, `albumCount` (empty string for missing ids so clients do not see undefined).

### 6.2 Musly

- **Full-library scans:**
  - The “All Albums” view does not page via `getAlbumList2`; instead it:
    - Calls `getArtists`.
    - For each artist, calls `getArtist?id=…` and uses `artist.album[]`.
    - For each album, calls `getAlbum?id=…` to load songs.
  - This is expected behavior against native Subsonic/Navidrome servers; Subfin should simply make these calls as fast as possible and rely on Musly’s local caching.
- **Favorites:**
  - Uses `getStarred2` for both songs and albums.
  - Starred songs and albums work correctly as long as `starred2` exposes:
    - `album[]` with `id` and `name` (and ideally `artist`, `created`).
    - `song[]` with full song fields.
  - Subfin provides these; album entries also include `artist`, `created`, `artistId`, `coverArt`, `songCount`, and `album` (same as name). Artists are included with `id`, `name`, `coverArt`, `albumCount`.
  - Musly currently does not send any follow-up REST calls when tapping a starred album tile; this appears to be a client limitation rather than something Subfin can fix.

### 6.3 Tempus – createShare and playlist IDs

- **createShare:** Some clients (e.g. Tempus) send the playlist id from `getPlaylists` **without** a `pl-` prefix (raw Jellyfin GUID). Subfin’s `getPlaylists` returns `id: p.id` (raw); only `coverArt` uses `pl-<id>`.
- **Impact:** `handleCreateShare` must accept raw playlist IDs: when an id has no `al-`/`pl-` prefix and `getSong` returns null, Subfin tries `getPlaylistItems` for that id so “share playlist” works. See `.tempus-analysis/ANALYSIS.md` for Tempus-specific notes.
- **Errors:** When no valid audio entries are found, Subfin returns a structured Subsonic error (not a bare throw) so clients can show a message instead of crashing.


