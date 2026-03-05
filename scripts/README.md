# Scripts

## Recently played debug (Jellyfin API)

**When to run:** To verify what Jellyfin returns for “recently played” albums vs tracks (e.g. if the Subfin “Recently Played” list looks wrong).

**Prerequisites:**

- `npm run build` so `dist/` exists.
- Config in `data/subfin.config.json` (or set `SUBFIN_CONFIG`). Salt and Jellyfin URL come from there.
- At least one linked device so `data/subfin.db` has credentials (script uses the same DB and salt to decrypt the Jellyfin token). Optional fallback: `.local-testing/subfin-api-credentials.json` with `jellyfin_user_id` and `jellyfin_access_token`.

**Run:**

```bash
# From repo root; uses data/subfin.config.json and data/subfin.db by default
node scripts/recently-played-debug.mjs
```

**What it does:** Calls Jellyfin’s `GetItems` with (1) MusicAlbum + SortBy=DatePlayed and (2) Audio + SortBy=DatePlayed, and prints the results. Subfin derives “Recently Played” albums from (2). If you get 401, re-link a device in the Subfin web UI to refresh the token.

---

## Playlist API test (Subfin + Jellyfin)

**When to run:** After you deploy Subfin and before validating in real clients (Musly, Tempus, DSub, etc.).

**Prerequisites:**

- Subfin running (local or deployed).
- `.local-testing/subfin-api-credentials.json` with `subsonic_username` and `app_password_plain` for the test account.
- Test account has at least one **shared playlist** (read-only; modify/delete expected to fail) and permission to **create** playlists (own playlists can be created and modified).

**Run:**

```bash
# Against local Subfin (default http://localhost:4040)
node scripts/playlist-api-test.mjs

# Against deployed Subfin
SUBFIN_URL=https://your-subfin.example.com node scripts/playlist-api-test.mjs
```

**What it does:**

- `getPlaylists` – list playlists.
- `getPlaylist(id)` – get one playlist (shared or own).
- `createPlaylist` – create a new playlist (own).
- `updatePlaylist` – add a song to the new playlist; then expect **failure** when updating a shared playlist.
- `deletePlaylist` – expect **failure** on shared playlist; then delete the created playlist.

Success: all steps report ✓. Shared playlist update/delete must be rejected (✓ “correctly rejected”).
