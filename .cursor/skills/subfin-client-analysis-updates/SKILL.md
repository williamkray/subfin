---
name: subfin-client-analysis-updates
description: Ensures newly discovered client-specific behaviors and quirks for Subfin test clients (Youamp, Musly, Tempus, Castafiore, DSub2000, Navic, etc.) are captured in their respective analysis files under the project’s client analysis directories. Use whenever a conversation, bugfix, or feature change reveals a new behavior, assumption, or limitation for a specific client.
---

# Subfin Client Analysis Updates

## When to use this skill

Use these instructions in the **subfin** repo whenever you:

- Discover or confirm a **client-specific behavior** or quirk (e.g. Musly’s all-albums scan pattern, DSub2000 XML parsing assumptions, Youamp’s non-null JSON fields).
- Fix a bug that is **only reproducible in a particular client**.
- Notice a client using an endpoint or parameter in a way that wasn’t previously documented.
- Add or change behavior in Subfin specifically **to satisfy one client’s expectations**.

The goal is to keep each client’s analysis notes in sync with what we’ve actually learned from real-world testing.

## Relevant client analysis directories

At the repo root, client analysis lives in per-client folders. Common ones include:

- `.youamp-analysis/` – Youamp source + docs; look for an analysis file such as `ANALYSIS.md`, `SUBFIN-NOTES.md`, or a dedicated section in `README.md`.
- `.navic-analysis/ANALYSIS.md`
- `.musly-analysis/ANALYSIS.md`
- `.tempus-analysis/ANALYSIS.md`
- `.castafiore-analysis/ANALYSIS.md`
- `.dsub2000-analysis/ANALYSIS.md`

If you are working with another client (or add a new one), follow the same pattern: create or update an `ANALYSIS.md` (or equivalent) under its `.<client>-analysis/` folder.

## What to record for a new client behavior

Whenever you identify a new behavior for a specific client, add a short, high-signal entry to that client’s analysis file. Capture at least:

1. **Context**
   - Client name and version (if known).
   - Rough area of the app (e.g. “artist screen”, “random songs”, “playlist detail”, “favorites”).
2. **Endpoints and parameters**
   - OpenSubsonic endpoint(s) involved (`getArtist`, `getRandomSongs`, `getPlaylist`, `getStarred2`, etc.).
   - Any notable query parameters or flags (e.g. always `f=json`, `u`/`t`+`s`, `type=random`, `size`, paging behavior).
3. **Behavior / expectation**
   - What the client **expects** from Subfin (fields that must be non-null, XML shape, JSON structure, redirects vs proxy behavior).
   - Any non-obvious call patterns (e.g. Musly’s full-library scan via `getArtists` → `getArtist` → `getAlbum`).
4. **Impact on Subfin**
   - What changes or guarantees Subfin now provides to satisfy this behavior (e.g. “always sets `displayArtist` in JSON”, “playlist `<playlist>` elements include `songCount` and `duration`”, “coverArt `pl-<id>` is supported in `getCoverArt`”).
5. **Reproduction notes (optional but helpful)**
   - Minimal steps to reproduce the behavior in that client.
   - Any log flags that are useful (`SUBFIN_LOG_REST`, Jellyfin logs, etc.).

Keep entries concise; they should be fast to skim when debugging.

## Workflow checklist

When a new client-specific behavior is discovered or fixed:

1. **Identify the client and behavior**
   - Name the client (Youamp, Musly, Tempus, Castafiore, DSub2000, Navic, etc.).
   - Summarize the behavior in one sentence (e.g. “DSub2000 crashes if playlist `duration` is null”).
2. **Locate the client’s analysis file**
   - Go to the corresponding `.<client>-analysis/` directory.
   - Open `ANALYSIS.md` (or the existing analysis markdown for that client).
3. **Add or update an entry**
   - If a relevant section already exists (e.g. “Playlists”, “Favorites”, “Streaming”), append a new bullet or short paragraph there.
   - Otherwise, create a small subsection (e.g. `### Playlists` or `### Favorites`) and add the new behavior notes.
4. **Cross-link when useful**
   - If the behavior directly informed a Subfin change (e.g. in `toSubsonicSong`, `getArtistInfo`, playlist handlers), mention the relevant Subfin function or endpoint briefly so future readers can jump to it.
5. **Keep it client-focused**
   - Record what is specific to that client (assumptions, quirks, patterns).
   - Avoid duplicating general Subfin/Jellyfin interop rules that already live in other skills unless they are being clarified for this client.

## Examples

- **Musly – all albums view**
  - Context: Musly’s “All Albums” grid.
  - Behavior: Instead of paging via `getAlbumList2`, Musly calls `getArtists`, then `getArtist?id=…`, then `getAlbum?id=…` for each album. Relies on these endpoints being reasonably fast and on album lists being complete.
  - Impact: Subfin should keep `getArtists` / `getArtist` / `getAlbum` efficient and ensure album lists are complete enough for Musly’s full-library scan.

- **DSub2000 – playlist integers**
  - Context: DSub2000 playlist detail screen (`getPlaylist`).
  - Behavior: Expects integer fields like `track`, `discNumber`, `duration`, `bitRate` to be non-null in playlist `<entry>` elements; null values can cause crashes when parsing.
  - Impact: Subfin ensures `toSubsonicSong` provides non-null defaults for these fields even when Jellyfin is missing data.

- **Youamp – JSON-only and non-null fields**
  - Context: Browsing albums and playlists with `f=json`.
  - Behavior: Uses JSON-only `subsonic-response` and has strict non-null models for many album, song, and playlist fields; missing `created`, `name`/`album`, or playlist headers can result in generic “Oops” errors.
  - Impact: Subfin always sets key JSON fields (like `id`, `artist`, `created` for albums; `id`, `title`, `suffix`, `contentType`, `size` for songs; and `id`, `name`, `owner`, `created`, `duration`, `songCount` for playlists), defaulting where necessary.

