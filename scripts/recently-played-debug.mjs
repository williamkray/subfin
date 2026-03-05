#!/usr/bin/env node
/**
 * Call Jellyfin APIs for "recently played" to compare albums vs tracks.
 *
 * Credentials and config:
 * - Prefer credentials from the Subfin DB (data/subfin.db) using the salt in
 *   data/subfin.config.json. Ensures you test with the same tokens the server uses.
 * - Config: data/subfin.config.json (or SUBFIN_CONFIG env). Jellyfin URL and salt come from there.
 * - Fallback: .local-testing/subfin-api-credentials.json if the DB has no linked devices.
 *
 * Run from repo root after `npm run build`:
 *   node scripts/recently-played-debug.mjs
 *
 * If you get 401, re-link a device in the Subfin web UI to refresh the Jellyfin token.
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Use data/ config and DB so we use the same credentials the running server uses.
process.env.SUBFIN_CONFIG = process.env.SUBFIN_CONFIG || join(root, "data", "subfin.config.json");
process.env.SUBFIN_DB_PATH = process.env.SUBFIN_DB_PATH || join(root, "data", "subfin.db");

function loadConfig() {
  const path = process.env.SUBFIN_CONFIG || join(root, "data", "subfin.config.json");
  if (!existsSync(path)) {
    const alt = join(root, "subfin.config.json");
    if (existsSync(alt)) return JSON.parse(readFileSync(alt, "utf8"));
    console.error("Missing config. Set SUBFIN_CONFIG or create data/subfin.config.json");
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function loadCredentialsFromStore() {
  try {
    const store = await import("../dist/store/index.js");
    const username = store.getFirstSubsonicUsername?.();
    if (!username) return null;
    return store.getJellyfinCredentialsForUser(username);
  } catch (e) {
    return null;
  }
}

function loadCredentialsFromFile() {
  const path = join(root, ".local-testing", "subfin-api-credentials.json");
  if (!existsSync(path)) return null;
  try {
    const creds = JSON.parse(readFileSync(path, "utf8"));
    return {
      jellyfinUserId: creds.jellyfin_user_id,
      jellyfinAccessToken: creds.jellyfin_access_token,
    };
  } catch {
    return null;
  }
}

async function jellyfinGet(baseUrl, token, pathname, searchParams = {}) {
  const url = new URL(pathname, baseUrl);
  Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `MediaBrowser Token="${token}"`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const config = loadConfig();
  const baseUrl = config.jellyfin?.baseUrl?.replace(/\/$/, "") || process.env.JELLYFIN_URL || "http://localhost:8096";

  let creds = await loadCredentialsFromStore();
  if (!creds) {
    creds = loadCredentialsFromFile();
    if (creds) console.log("Using credentials from .local-testing/subfin-api-credentials.json (fallback)\n");
  } else {
    console.log("Using credentials from Subfin DB (data/subfin.db)\n");
  }

  if (!creds) {
    console.error("No credentials. Link a device in the Subfin web UI (or add .local-testing/subfin-api-credentials.json).");
    process.exit(1);
  }

  const { jellyfinUserId: userId, jellyfinAccessToken: token } = creds;
  console.log("Config:", process.env.SUBFIN_CONFIG);
  console.log("Jellyfin base URL:", baseUrl);
  console.log("User ID:", userId);
  console.log("");

  // 1) Recently played ALBUMS (album-level DatePlayed — often wrong for music)
  console.log("=== 1) Albums sorted by DatePlayed (album-level; often stale for music) ===");
  try {
    const albumRes = await jellyfinGet(baseUrl, token, `/Users/${userId}/Items`, {
      IncludeItemTypes: "MusicAlbum",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      Recursive: "true",
      EnableUserData: "true",
      Limit: "20",
      Fields: "Id,Name,AlbumArtist,ParentId,UserData",
    });
    const albums = albumRes.Items || [];
    console.log("Count:", albums.length);
    albums.forEach((a, i) => {
      const ud = a.UserData || {};
      console.log(`  ${i + 1}. ${a.AlbumArtist || "?"} - ${a.Name} (id=${a.Id}) LastPlayedDate=${ud.LastPlayedDate ?? "null"}`);
    });
  } catch (e) {
    console.error("Error:", e.message);
  }

  console.log("");

  // 2) Recently played TRACKS (Audio) — this is what Subfin uses for "Recently Played" albums
  console.log("=== 2) Tracks (Audio) sorted by DatePlayed (what Subfin uses for recent albums) ===");
  try {
    const audioRes = await jellyfinGet(baseUrl, token, `/Users/${userId}/Items`, {
      IncludeItemTypes: "Audio",
      SortBy: "DatePlayed",
      SortOrder: "Descending",
      Recursive: "true",
      EnableUserData: "true",
      Limit: "20",
      Fields: "Id,Name,Album,AlbumArtist,AlbumId,ParentId,UserData",
    });
    const tracks = audioRes.Items || [];
    console.log("Count:", tracks.length);
    tracks.forEach((t, i) => {
      const ud = t.UserData || {};
      console.log(`  ${i + 1}. ${t.AlbumArtist || "?"} - ${t.Name} (albumId=${t.AlbumId ?? t.ParentId}) LastPlayedDate=${ud.LastPlayedDate ?? "null"}`);
    });
  } catch (e) {
    console.error("Error:", e.message);
  }

  console.log("");
  console.log("Subfin derives 'Recently Played' albums from (2). If (2) is empty or wrong, check that");
  console.log("scrobbles are being sent and that userId is passed in getItems (fixed in Subfin).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
