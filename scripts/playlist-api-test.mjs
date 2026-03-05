#!/usr/bin/env node
/**
 * Playlist CRUD API tests against Subfin.
 * Uses credentials from .local-testing/subfin-api-credentials.json.
 * Run after Subfin is deployed: SUBFIN_URL=https://your-subfin node scripts/playlist-api-test.mjs
 *
 * Expects:
 * - Shared playlists (read-only): getPlaylists/getPlaylist work; update/delete fail.
 * - Own playlists: create, update, delete succeed.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const SUBFIN_URL = process.env.SUBFIN_URL || "http://localhost:4040";

function loadCredentials() {
  const path = join(root, ".local-testing", "subfin-api-credentials.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error("Missing or invalid .local-testing/subfin-api-credentials.json");
    process.exit(1);
  }
}

function baseParams(creds) {
  return new URLSearchParams({
    u: creds.subsonic_username,
    p: creds.app_password_plain,
    f: "json",
    v: "1.16.1",
    c: "playlist-api-test",
  });
}

async function rest(method, params = {}) {
  const q = new URLSearchParams(baseParams(loadCredentials()));
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((val) => q.append(k, val));
    else if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const url = `${SUBFIN_URL}/rest/${method}?${q}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
  const sr = data["subsonic-response"];
  if (!sr) throw new Error("No subsonic-response in body");
  if (sr.status !== "ok") {
    const err = sr.error || {};
    throw new Error(err.message || `status ${sr.status}`);
  }
  return sr;
}

function ok(name) {
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  console.log(`  ✗ ${name}: ${err.message}`);
}

async function main() {
  const creds = loadCredentials();
  console.log(`Subfin URL: ${SUBFIN_URL}`);
  console.log(`User: ${creds.subsonic_username}`);
  console.log("");

  let sharedPlaylistId = null;
  let createdPlaylistId = null;
  let oneSongId = null;

  // --- getPlaylists
  try {
    const sr = await rest("getPlaylists");
    const list = sr.playlists?.playlist || [];
    ok(`getPlaylists (${list.length} playlists)`);
    if (list.length > 0) {
      sharedPlaylistId = list[0].id;
      if (list[0].owner !== creds.subsonic_username) {
        ok("  (first playlist is shared/read-only)");
      }
    }
  } catch (e) {
    fail("getPlaylists", e);
  }

  // --- getPlaylist (shared or first)
  if (sharedPlaylistId) {
    try {
      const sr = await rest("getPlaylist", { id: sharedPlaylistId });
      const pl = sr.playlist || {};
      const entries = pl.entry || [];
      ok(`getPlaylist(${sharedPlaylistId}) (${entries.length} entries)`);
      if (entries.length > 0 && !oneSongId) oneSongId = entries[0].id;
    } catch (e) {
      fail("getPlaylist(shared)", e);
    }
  }

  // --- Get one song id for add-to-playlist (search3 if we don't have from playlist)
  if (!oneSongId) {
    try {
      const sr = await rest("search3", { query: "a", songCount: 1 });
      const songs = sr.searchResult3?.song || [];
      if (songs.length > 0) oneSongId = songs[0].id;
    } catch (e) {
      console.log("  (no song id for add test, search3 failed or empty)");
    }
  }

  // --- createPlaylist (own)
  try {
    const sr = await rest("createPlaylist", { name: "Subfin API test " + Date.now() });
    createdPlaylistId = sr.playlist?.id;
    if (createdPlaylistId) ok(`createPlaylist → ${createdPlaylistId}`);
    else fail("createPlaylist", new Error("No id in response"));
  } catch (e) {
    fail("createPlaylist", e);
  }

  // --- updatePlaylist: add song (own playlist)
  if (createdPlaylistId && oneSongId) {
    try {
      await rest("updatePlaylist", {
        playlistId: createdPlaylistId,
        songIdToAdd: oneSongId,
      });
      ok("updatePlaylist (add song)");
    } catch (e) {
      fail("updatePlaylist (add song)", e);
    }
  }

  // --- updatePlaylist on shared playlist (expect failure)
  if (sharedPlaylistId && sharedPlaylistId !== createdPlaylistId) {
    try {
      await rest("updatePlaylist", {
        playlistId: sharedPlaylistId,
        name: "Should not change",
      });
      fail("updatePlaylist(shared)", new Error("Expected failure"));
    } catch (e) {
      if (e.message.includes("Not allowed") || e.message.includes("403") || e.message.includes("Forbidden")) {
        ok("updatePlaylist(shared) correctly rejected");
      } else {
        fail("updatePlaylist(shared)", e);
      }
    }
  }

  // --- deletePlaylist on shared (expect failure)
  if (sharedPlaylistId && sharedPlaylistId !== createdPlaylistId) {
    try {
      await rest("deletePlaylist", { id: sharedPlaylistId });
      fail("deletePlaylist(shared)", new Error("Expected failure"));
    } catch (e) {
      if (e.message.includes("Not allowed") || e.message.includes("403") || e.message.includes("Forbidden")) {
        ok("deletePlaylist(shared) correctly rejected");
      } else {
        fail("deletePlaylist(shared)", e);
      }
    }
  }

  // --- deletePlaylist (own)
  if (createdPlaylistId) {
    try {
      await rest("deletePlaylist", { id: createdPlaylistId });
      ok("deletePlaylist(own)");
    } catch (e) {
      fail("deletePlaylist(own)", e);
    }
  }

  console.log("");
  console.log("Done. Validate in real clients (Musly, Tempus, DSub, etc.) as needed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
