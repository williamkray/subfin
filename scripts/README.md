# Scripts

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
