/**
 * Token and app-password store. SQLite with encrypted sensitive columns (key from config salt).
 * One-time migration from legacy JSON store if present.
 */
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import { randomFillSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config/load.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "./crypto.js";
import type { UserKey } from "./types.js";
import { assertUserKey } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SALT_ROUNDS = 10;

let db: Database.Database | null = null;

function getDbPath(): string {
  return resolve(process.cwd(), config.dbPath);
}

function getLegacyJsonPath(): string {
  return getDbPath().replace(/\.db$/i, ".json");
}

function openDb(): Database.Database {
  if (db) return db;
  const path = getDbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  runSchema(db);
  migrateFromLegacyJsonIfPresent();
  backfillJellyfinUrls(db);
  return db;
}

function runSchema(database: Database.Database): void {
  const schemaPath = resolve(__dirname, "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");
  database.exec(sql);

  const linkedDevicesInfo = database.prepare("PRAGMA table_info(linked_devices)").all() as { name: string }[];

  // Migration: add Jellyfin device id/name for share (QC) devices so requests use the same device.
  const hasJellyfinDeviceId = linkedDevicesInfo.some((c) => c.name === "jellyfin_device_id");
  if (!hasJellyfinDeviceId) {
    database.exec("ALTER TABLE linked_devices ADD COLUMN jellyfin_device_id TEXT");
    database.exec("ALTER TABLE linked_devices ADD COLUMN jellyfin_device_name TEXT");
  }

  // Migration: store share secret encrypted so we can show full share URL in the web UI.
  const sharesInfo = database.prepare("PRAGMA table_info(shares)").all() as { name: string }[];
  const hasShareSecret = sharesInfo.some((c) => c.name === "share_secret_encrypted");
  if (!hasShareSecret) {
    database.exec("ALTER TABLE shares ADD COLUMN share_secret_encrypted BLOB");
  }

  // Migration: add derived_cache table for cached artist indexes and other derived views.
  const derivedInfo = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derived_cache'").get() as
    | { name: string }
    | undefined;
  if (!derivedInfo) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS derived_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        cached_at TEXT NOT NULL,
        last_source_change_at TEXT
      );
    `);
  }

  // Migration: multi-tenant — add jellyfin_url to linked_devices if missing.
  const hasJellyfinUrl = linkedDevicesInfo.some((c) => c.name === "jellyfin_url");
  if (!hasJellyfinUrl) {
    database.exec("ALTER TABLE linked_devices ADD COLUMN jellyfin_url TEXT NOT NULL DEFAULT ''");
    database.exec("CREATE INDEX IF NOT EXISTS idx_linked_devices_username_url ON linked_devices(subsonic_username, jellyfin_url)");
  }

  // Migration: add jellyfin_url to pending_quickconnect if missing.
  const pendingInfo = database.prepare("PRAGMA table_info(pending_quickconnect)").all() as { name: string }[];
  const pendingHasUrl = pendingInfo.some((c) => c.name === "jellyfin_url");
  if (!pendingHasUrl) {
    database.exec("ALTER TABLE pending_quickconnect ADD COLUMN jellyfin_url TEXT NOT NULL DEFAULT ''");
  }

  // Migration: recreate jellyfin_sessions with composite PK (subsonic_username, jellyfin_url).
  // Old table had PRIMARY KEY (subsonic_username) only. SQLite can't ALTER PRIMARY KEY.
  const sessionPkInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='jellyfin_sessions'"
  ).get() as { sql: string } | undefined;
  const sessionNeedsCompositePk = sessionPkInfo && !sessionPkInfo.sql.includes("PRIMARY KEY (subsonic_username, jellyfin_url)");
  if (sessionNeedsCompositePk) {
    database.exec(`
      CREATE TABLE jellyfin_sessions_new (
        subsonic_username TEXT NOT NULL,
        jellyfin_url TEXT NOT NULL DEFAULT '',
        jellyfin_user_id TEXT NOT NULL,
        jellyfin_access_token_encrypted BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (subsonic_username, jellyfin_url)
      );
      INSERT OR IGNORE INTO jellyfin_sessions_new (subsonic_username, jellyfin_url, jellyfin_user_id, jellyfin_access_token_encrypted, created_at)
        SELECT subsonic_username, COALESCE(jellyfin_url, ''), jellyfin_user_id, jellyfin_access_token_encrypted, created_at
        FROM jellyfin_sessions;
      DROP TABLE jellyfin_sessions;
      ALTER TABLE jellyfin_sessions_new RENAME TO jellyfin_sessions;
    `);
  }

  // Migration: recreate play_queue with composite PK (subsonic_username, jellyfin_url).
  // Also handles adding current_index if the table was newly recreated.
  const playQueuePkInfo = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='play_queue'"
  ).get() as { sql: string } | undefined;
  const playQueueNeedsCompositePk = playQueuePkInfo && !playQueuePkInfo.sql.includes("PRIMARY KEY (subsonic_username, jellyfin_url)");
  if (playQueueNeedsCompositePk) {
    database.exec(`
      CREATE TABLE play_queue_new (
        subsonic_username TEXT NOT NULL,
        jellyfin_url TEXT NOT NULL DEFAULT '',
        entry_ids TEXT NOT NULL,
        current_id TEXT,
        current_index INTEGER NOT NULL DEFAULT 0,
        position_ms INTEGER NOT NULL DEFAULT 0,
        changed_at TEXT NOT NULL,
        changed_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (subsonic_username, jellyfin_url)
      );
      INSERT OR IGNORE INTO play_queue_new (subsonic_username, jellyfin_url, entry_ids, current_id, current_index, position_ms, changed_at, changed_by)
        SELECT subsonic_username, COALESCE(jellyfin_url, ''), entry_ids, current_id, COALESCE(current_index, 0), position_ms, changed_at, COALESCE(changed_by, '')
        FROM play_queue;
      DROP TABLE play_queue;
      ALTER TABLE play_queue_new RENAME TO play_queue;
    `);
  } else {
    // play_queue already has composite PK; ensure current_index column exists (old migration path).
    const playQueueInfo = database.prepare("PRAGMA table_info(play_queue)").all() as { name: string }[];
    const hasCurrentIndex = playQueueInfo.some((c) => c.name === "current_index");
    if (!hasCurrentIndex) {
      database.exec("ALTER TABLE play_queue ADD COLUMN current_index INTEGER NOT NULL DEFAULT 0");
    }
  }
}

/** After schema migration, backfill empty jellyfin_url values for existing single-tenant data. */
function backfillJellyfinUrls(database: Database.Database): void {
  const cfg = getConfig();
  if (cfg.allowedJellyfinHosts.length !== 1) return;
  const url = cfg.allowedJellyfinHosts[0]!;
  database.prepare("UPDATE linked_devices SET jellyfin_url = ? WHERE jellyfin_url = ''").run(url);
  database.prepare("UPDATE jellyfin_sessions SET jellyfin_url = ? WHERE jellyfin_url = ''").run(url);
  database.prepare("UPDATE play_queue SET jellyfin_url = ? WHERE jellyfin_url = ''").run(url);
  database.prepare("UPDATE pending_quickconnect SET jellyfin_url = ? WHERE jellyfin_url = ''").run(url);
}

interface LegacyLinkedDevice {
  id: number;
  subsonic_username: string;
  app_password_hash: string;
  app_password_plain?: string;
  jellyfin_user_id: string;
  jellyfin_access_token: string;
  device_label: string | null;
  created_at: string;
}

interface LegacyStoreData {
  nextId?: number;
  linked_devices: LegacyLinkedDevice[];
  pending_quickconnect?: Record<string, { jellyfin_user_id: string; jellyfin_access_token: string; created_at: string }>;
}

function migrateFromLegacyJsonIfPresent(): void {
  const legacyPath = getLegacyJsonPath();
  if (!existsSync(legacyPath)) return;
  const cfg = getConfig();
  let data: LegacyStoreData;
  try {
    data = JSON.parse(readFileSync(legacyPath, "utf-8")) as LegacyStoreData;
  } catch {
    return;
  }
  if (!data.linked_devices || !Array.isArray(data.linked_devices)) return;
  const database = db!;
  const insertDevice = database.prepare(`
    INSERT INTO linked_devices (subsonic_username, app_password_hash, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPending = database.prepare(`
    INSERT INTO pending_quickconnect (secret, jellyfin_user_id, jellyfin_access_token_encrypted, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const runMany = database.transaction(() => {
    for (const d of data.linked_devices) {
      const plain = d.app_password_plain ?? "";
      const appEnc = encrypt(plain, cfg);
      const tokenEnc = encrypt(d.jellyfin_access_token, cfg);
      insertDevice.run(
        d.subsonic_username,
        d.app_password_hash,
        appEnc,
        d.jellyfin_user_id,
        tokenEnc,
        d.device_label ?? null,
        d.created_at
      );
    }
    const pending = data.pending_quickconnect ?? {};
    for (const [secret, row] of Object.entries(pending)) {
      const tokenEnc = encrypt(row.jellyfin_access_token, cfg);
      insertPending.run(secret, row.jellyfin_user_id, tokenEnc, row.created_at);
    }
  });
  runMany();
  try {
    renameSync(legacyPath, legacyPath + ".migrated");
  } catch {
    // best effort
  }
  console.log("Migrated store from", legacyPath, "to SQLite");
}

export interface LinkedDevice {
  id: number;
  subsonic_username: string;
  app_password_hash?: string;
  jellyfin_user_id: string;
  device_label: string | null;
  created_at: string;
}

export interface DerivedCacheEntry<T = unknown> {
  cacheKey: string;
  value: T;
  cachedAt: string;
  lastSourceChangeAt: string | null;
}

/** Read a derived cache entry by key. Returns parsed JSON or null on miss. */
export function getDerivedCache<T = unknown>(cacheKey: string): DerivedCacheEntry<T> | null {
  const database = openDb();
  const row = database
    .prepare(
      "SELECT cache_key as cacheKey, value_json as valueJson, cached_at as cachedAt, last_source_change_at as lastSourceChangeAt FROM derived_cache WHERE cache_key = ?"
    )
    .get(cacheKey) as
    | { cacheKey: string; valueJson: string; cachedAt: string; lastSourceChangeAt: string | null }
    | undefined;
  if (!row) return null;
  let parsed: T;
  try {
    parsed = JSON.parse(row.valueJson) as T;
  } catch {
    // On parse failure, treat as cache miss so we can overwrite with a fresh value.
    return null;
  }
  return {
    cacheKey: row.cacheKey,
    value: parsed,
    cachedAt: row.cachedAt,
    lastSourceChangeAt: row.lastSourceChangeAt,
  };
}

/** Upsert a derived cache entry. value is JSON-serialized. */
export function setDerivedCache<T = unknown>(
  cacheKey: string,
  value: T,
  lastSourceChangeAt: string | null
): void {
  const database = openDb();
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(value);
  database
    .prepare(
      `INSERT INTO derived_cache (cache_key, value_json, cached_at, last_source_change_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         value_json = excluded.value_json,
         cached_at = excluded.cached_at,
         last_source_change_at = excluded.last_source_change_at`
    )
    .run(cacheKey, valueJson, now, lastSourceChangeAt);
}

function generateAppPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const bytes = new Uint8Array(24);
  randomFillSync(bytes);
  for (let i = 0; i < 24; i++) s += chars[bytes[i]! % chars.length];
  return s;
}

/** Add a linked device; returns the plain app password (show once).
 * When linking via Quick Connect, pass jellyfinDeviceId and jellyfinDeviceName so all Jellyfin
 * requests use that device and it appears as a distinct device in the Jellyfin dashboard. */
export function addLinkedDevice(
  key: UserKey,
  jellyfinUserId: string,
  jellyfinAccessToken: string,
  deviceLabel?: string,
  jellyfinDeviceId?: string,
  jellyfinDeviceName?: string
): string {
  assertUserKey(key);
  const cfg = getConfig();
  const database = openDb();
  const plainPassword = generateAppPassword();
  const hash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
  const appEnc = encrypt(plainPassword, cfg);
  const tokenEnc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO linked_devices (subsonic_username, jellyfin_url, app_password_hash, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label, jellyfin_device_id, jellyfin_device_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key.subsonicUsername,
      key.jellyfinUrl,
      hash,
      appEnc,
      jellyfinUserId,
      tokenEnc,
      deviceLabel ?? null,
      jellyfinDeviceId ?? null,
      jellyfinDeviceName ?? null,
      created
    );
  return plainPassword;
}

/** Resolve Subsonic (username, password) to Jellyfin token and matched device.
 * Returns jellyfinUrl from the matching linked device (namespace boundary for multi-tenant). */
export function resolveToJellyfinToken(
  subsonicUsername: string,
  password: string
): {
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  jellyfinUrl: string;
  deviceId: number;
  deviceLabel: string | null;
} | null {
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, jellyfin_url, jellyfin_user_id, app_password_hash, jellyfin_access_token_encrypted, device_label FROM linked_devices WHERE subsonic_username = ?"
    )
    .all(subsonicUsername) as {
      id: number;
      jellyfin_url: string;
      jellyfin_user_id: string;
      app_password_hash: string;
      jellyfin_access_token_encrypted: Buffer;
      device_label: string | null;
    }[];
  const cfg = getConfig();
  for (const row of rows) {
    if (bcrypt.compareSync(password, row.app_password_hash)) {
      const token = decrypt(row.jellyfin_access_token_encrypted, cfg);
      return {
        jellyfinUserId: row.jellyfin_user_id,
        jellyfinAccessToken: token,
        jellyfinUrl: row.jellyfin_url,
        deviceId: row.id,
        deviceLabel: row.device_label,
      };
    }
  }
  return null;
}

/** Get Jellyfin credentials for a user on a specific Jellyfin server. */
export function getJellyfinCredentialsForUser(
  key: UserKey
): { jellyfinUserId: string; jellyfinAccessToken: string } | null {
  assertUserKey(key);
  const database = openDb();
  // Prefer explicit Jellyfin session (auth-only step), fall back to any linked device.
  const sessionRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM jellyfin_sessions WHERE subsonic_username = ? AND jellyfin_url = ?"
    )
    .get(key.subsonicUsername, key.jellyfinUrl) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;

  const cfg = getConfig();

  if (sessionRow) {
    const token = decrypt(sessionRow.jellyfin_access_token_encrypted, cfg);
    return { jellyfinUserId: sessionRow.jellyfin_user_id, jellyfinAccessToken: token };
  }

  const deviceRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM linked_devices WHERE subsonic_username = ? AND jellyfin_url = ? LIMIT 1"
    )
    .get(key.subsonicUsername, key.jellyfinUrl) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;
  if (!deviceRow) return null;
  const token = decrypt(deviceRow.jellyfin_access_token_encrypted, cfg);
  return { jellyfinUserId: deviceRow.jellyfin_user_id, jellyfinAccessToken: token };
}

/** Get Jellyfin credentials best suited for "link another device" (Quick Connect authorize).
 * Prefers the most recently linked device's token so each token is used for at most one
 * QC authorize (Jellyfin may reject 401 after a token has authorized once or twice). */
export function getJellyfinCredentialsForLinking(
  key: UserKey
): { jellyfinUserId: string; jellyfinAccessToken: string } | null {
  assertUserKey(key);
  const database = openDb();
  const cfg = getConfig();
  // Use most recently linked device (fresh token not yet used for QC authorize).
  const deviceRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM linked_devices WHERE subsonic_username = ? AND jellyfin_url = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(key.subsonicUsername, key.jellyfinUrl) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;
  if (deviceRow) {
    const token = decrypt(deviceRow.jellyfin_access_token_encrypted, cfg);
    return { jellyfinUserId: deviceRow.jellyfin_user_id, jellyfinAccessToken: token };
  }
  // No linked devices yet (first device): use session from initial QC login.
  const sessionRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM jellyfin_sessions WHERE subsonic_username = ? AND jellyfin_url = ?"
    )
    .get(key.subsonicUsername, key.jellyfinUrl) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;
  if (!sessionRow) return null;
  const token = decrypt(sessionRow.jellyfin_access_token_encrypted, cfg);
  return { jellyfinUserId: sessionRow.jellyfin_user_id, jellyfinAccessToken: token };
}

/** Return the first linked device's Subsonic username, or null if none. Used by debug scripts to resolve credentials from the DB. */
export function getFirstSubsonicUsername(): string | null {
  const database = openDb();
  const row = database
    .prepare("SELECT subsonic_username FROM linked_devices ORDER BY created_at ASC LIMIT 1")
    .get() as { subsonic_username: string } | undefined;
  return row?.subsonic_username ?? null;
}

/** List linked devices for a Subsonic username on a specific Jellyfin server. */
export function listLinkedDevices(
  key: UserKey
): Omit<LinkedDevice, "app_password_hash">[] {
  assertUserKey(key);
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, subsonic_username, jellyfin_user_id, device_label, created_at FROM linked_devices WHERE subsonic_username = ? AND jellyfin_url = ? ORDER BY created_at DESC"
    )
    .all(key.subsonicUsername, key.jellyfinUrl) as { id: number; subsonic_username: string; jellyfin_user_id: string; device_label: string | null; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    subsonic_username: r.subsonic_username,
    jellyfin_user_id: r.jellyfin_user_id,
    device_label: r.device_label,
    created_at: r.created_at,
  }));
}

/** Get the Jellyfin access token for a single device (for logout-on-unlink). */
export function getDeviceJellyfinToken(
  deviceId: number,
  subsonicUsername: string
): string | null {
  const database = openDb();
  const row = database
    .prepare(
      "SELECT jellyfin_access_token_encrypted FROM linked_devices WHERE id = ? AND subsonic_username = ?"
    )
    .get(deviceId, subsonicUsername) as { jellyfin_access_token_encrypted: Buffer } | undefined;
  if (!row) return null;
  const cfg = getConfig();
  return decrypt(row.jellyfin_access_token_encrypted, cfg);
}

/** Unlink a device by id. Returns true if deleted. */
export function unlinkDevice(deviceId: number, subsonicUsername: string): boolean {
  const database = openDb();
  const result = database
    .prepare("DELETE FROM linked_devices WHERE id = ? AND subsonic_username = ?")
    .run(deviceId, subsonicUsername);
  return result.changes > 0;
}

/** Rename a device label. Returns true if updated. */
export function renameDevice(
  deviceId: number,
  subsonicUsername: string,
  newLabel: string | null
): boolean {
  const database = openDb();
  const result = database
    .prepare(
      "UPDATE linked_devices SET device_label = ? WHERE id = ? AND subsonic_username = ?"
    )
    .run(newLabel, deviceId, subsonicUsername);
  return result.changes > 0;
}

/** Reset app password for a device. Returns new plain password, or null if not found. */
export function resetAppPassword(deviceId: number, subsonicUsername: string): string | null {
  const database = openDb();
  const row = database
    .prepare(
      "SELECT jellyfin_access_token_encrypted FROM linked_devices WHERE id = ? AND subsonic_username = ?"
    )
    .get(deviceId, subsonicUsername) as { jellyfin_access_token_encrypted: Buffer } | undefined;
  if (!row) return null;
  const cfg = getConfig();
  const newPassword = generateAppPassword();
  const hash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  const appEnc = encrypt(newPassword, cfg);
  database
    .prepare(
      "UPDATE linked_devices SET app_password_hash = ?, app_password_encrypted = ? WHERE id = ? AND subsonic_username = ?"
    )
    .run(hash, appEnc, deviceId, subsonicUsername);
  return newPassword;
}

export interface LinkedDeviceForToken {
  subsonic_username: string;
  app_password_plain?: string;
  jellyfin_user_id: string;
  jellyfin_access_token: string;
  device_id: number;
  device_label: string | null;
}

/** Internal: all devices for a username across all Jellyfin servers (for t+s token auth where URL isn't yet known). */
export function getDevicesForTokenAllServers(subsonicUsername: string): (LinkedDeviceForToken & { jellyfin_url: string })[] {
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, subsonic_username, jellyfin_url, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label FROM linked_devices WHERE subsonic_username = ?"
    )
    .all(subsonicUsername) as {
      id: number;
      subsonic_username: string;
      jellyfin_url: string;
      app_password_encrypted: Buffer;
      jellyfin_user_id: string;
      jellyfin_access_token_encrypted: Buffer;
      device_label: string | null;
    }[];
  const cfg = getConfig();
  return rows.map((r) => {
    const plain = decrypt(r.app_password_encrypted, cfg);
    const token = decrypt(r.jellyfin_access_token_encrypted, cfg);
    return {
      subsonic_username: r.subsonic_username,
      jellyfin_url: r.jellyfin_url,
      app_password_plain: plain || undefined,
      jellyfin_user_id: r.jellyfin_user_id,
      jellyfin_access_token: token,
      device_id: r.id,
      device_label: r.device_label,
    };
  });
}

/** Internal: devices for a user+server including plain app password (for token auth). */
export function getDevicesForToken(key: UserKey): LinkedDeviceForToken[] {
  assertUserKey(key);
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, subsonic_username, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label FROM linked_devices WHERE subsonic_username = ? AND jellyfin_url = ?"
    )
    .all(key.subsonicUsername, key.jellyfinUrl) as {
      id: number;
      subsonic_username: string;
      app_password_encrypted: Buffer;
      jellyfin_user_id: string;
      jellyfin_access_token_encrypted: Buffer;
      device_label: string | null;
    }[];
  const cfg = getConfig();
  return rows.map((r) => {
    const plain = decrypt(r.app_password_encrypted, cfg);
    const token = decrypt(r.jellyfin_access_token_encrypted, cfg);
    return {
      subsonic_username: r.subsonic_username,
      app_password_plain: plain || undefined,
      jellyfin_user_id: r.jellyfin_user_id,
      jellyfin_access_token: token,
      device_id: r.id,
      device_label: r.device_label,
    };
  });
}

/** Store pending QuickConnect result. jellyfinUrl identifies which Jellyfin server the token belongs to. */
export function setPendingQuickConnect(
  secret: string,
  jellyfinUrl: string,
  jellyfinUserId: string,
  jellyfinAccessToken: string
): void {
  const cfg = getConfig();
  const database = openDb();
  const enc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  // Enforce TTL and a maximum number of pending entries per Jellyfin user to avoid unbounded growth.
  const ttlMs = 10 * 60 * 1000; // 10 minutes
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  // Delete all expired entries for this user.
  database
    .prepare(
      "DELETE FROM pending_quickconnect WHERE jellyfin_user_id = ? AND created_at < ?"
    )
    .run(jellyfinUserId, cutoff);
  // If still too many non-expired entries, delete oldest until under limit.
  const maxPendingPerUser = 50;
  const rows = database
    .prepare(
      "SELECT secret FROM pending_quickconnect WHERE jellyfin_user_id = ? ORDER BY created_at ASC"
    )
    .all(jellyfinUserId) as { secret: string }[];
  if (rows.length >= maxPendingPerUser) {
    const toDelete = rows.length - maxPendingPerUser + 1;
    const secretsToDelete = rows.slice(0, toDelete).map((r) => r.secret);
    const stmt = database.prepare("DELETE FROM pending_quickconnect WHERE secret = ?");
    const tx = database.transaction((list: string[]) => {
      for (const s of list) stmt.run(s);
    });
    tx(secretsToDelete);
  }
  database
    .prepare(
      "INSERT OR REPLACE INTO pending_quickconnect (secret, jellyfin_url, jellyfin_user_id, jellyfin_access_token_encrypted, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(secret, jellyfinUrl, jellyfinUserId, enc, created);
}

/** Get and remove pending QuickConnect result. Returns jellyfinUrl alongside credentials. */
export function consumePendingQuickConnect(
  secret: string
): { jellyfinUrl: string; jellyfinUserId: string; jellyfinAccessToken: string } | null {
  const database = openDb();
  const ttlMs = 10 * 60 * 1000; // 10 minutes
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const row = database
    .prepare(
      "SELECT jellyfin_url, jellyfin_user_id, jellyfin_access_token_encrypted, created_at FROM pending_quickconnect WHERE secret = ?"
    )
    .get(secret) as { jellyfin_url: string; jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer; created_at: string } | undefined;
  if (!row || row.created_at < cutoff) {
    // Expired or missing: ensure it's removed and treat as not found.
    database.prepare("DELETE FROM pending_quickconnect WHERE secret = ?").run(secret);
    return null;
  }
  database.prepare("DELETE FROM pending_quickconnect WHERE secret = ?").run(secret);
  const cfg = getConfig();
  const token = decrypt(row.jellyfin_access_token_encrypted, cfg);
  return { jellyfinUrl: row.jellyfin_url, jellyfinUserId: row.jellyfin_user_id, jellyfinAccessToken: token };
}

/** Invalidate all stored tokens for a Jellyfin user. */
export function invalidateTokensForJellyfinUser(jellyfinUserId: string): void {
  const database = openDb();
  database.prepare("DELETE FROM linked_devices WHERE jellyfin_user_id = ?").run(jellyfinUserId);
  database.prepare("DELETE FROM jellyfin_sessions WHERE jellyfin_user_id = ?").run(jellyfinUserId);
}

/** Store a Jellyfin session for a (Subsonic username, Jellyfin URL) pair (auth step without linking a device). */
export function setJellyfinSession(
  key: UserKey,
  jellyfinUserId: string,
  jellyfinAccessToken: string
): void {
  assertUserKey(key);
  const cfg = getConfig();
  const database = openDb();
  const enc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO jellyfin_sessions (subsonic_username, jellyfin_url, jellyfin_user_id, jellyfin_access_token_encrypted, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(subsonic_username, jellyfin_url) DO UPDATE SET
         jellyfin_user_id = excluded.jellyfin_user_id,
         jellyfin_access_token_encrypted = excluded.jellyfin_access_token_encrypted,
         created_at = excluded.created_at`
    )
    .run(key.subsonicUsername, key.jellyfinUrl, jellyfinUserId, enc, created);
}

/** Save play queue for a user+server (OpenSubsonic savePlayQueue). Replaces any existing queue. */
export function savePlayQueue(
  key: UserKey,
  data: { entryIds: string[]; currentId: string | null; currentIndex: number; positionMs: number; changedBy: string }
): void {
  assertUserKey(key);
  const database = openDb();
  const changedAt = new Date().toISOString();
  const entryIdsJson = JSON.stringify(data.entryIds);
  database
    .prepare(
      `INSERT INTO play_queue (subsonic_username, jellyfin_url, entry_ids, current_id, current_index, position_ms, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subsonic_username, jellyfin_url) DO UPDATE SET
         entry_ids = excluded.entry_ids,
         current_id = excluded.current_id,
         current_index = excluded.current_index,
         position_ms = excluded.position_ms,
         changed_at = excluded.changed_at,
         changed_by = excluded.changed_by`
    )
    .run(
      key.subsonicUsername,
      key.jellyfinUrl,
      entryIdsJson,
      data.currentId ?? null,
      Math.max(0, data.currentIndex),
      Math.max(0, data.positionMs),
      changedAt,
      data.changedBy?.trim().slice(0, 255) ?? ""
    );
}

/** Get saved play queue for a user+server, or null if none. */
export function getPlayQueue(key: UserKey): {
  entryIds: string[];
  currentId: string | null;
  currentIndex: number;
  positionMs: number;
  changedAt: string;
  changedBy: string;
} | null {
  assertUserKey(key);
  const database = openDb();
  const row = database
    .prepare(
      "SELECT entry_ids, current_id, current_index, position_ms, changed_at, changed_by FROM play_queue WHERE subsonic_username = ? AND jellyfin_url = ?"
    )
    .get(key.subsonicUsername, key.jellyfinUrl) as
    | { entry_ids: string; current_id: string | null; current_index: number; position_ms: number; changed_at: string; changed_by: string }
    | undefined;
  if (!row) return null;
  let entryIds: string[];
  try {
    entryIds = JSON.parse(row.entry_ids) as string[];
    if (!Array.isArray(entryIds)) entryIds = [];
  } catch {
    entryIds = [];
  }
  return {
    entryIds,
    currentId: row.current_id ?? null,
    currentIndex: Math.max(0, row.current_index ?? 0),
    positionMs: Math.max(0, row.position_ms),
    changedAt: row.changed_at,
    changedBy: row.changed_by ?? "",
  };
}

/** Clear saved play queue for a user+server (savePlayQueue with no ids). */
export function clearPlayQueue(key: UserKey): void {
  assertUserKey(key);
  const database = openDb();
  database.prepare("DELETE FROM play_queue WHERE subsonic_username = ? AND jellyfin_url = ?").run(key.subsonicUsername, key.jellyfinUrl);
}

// --- Shares (public share = one linked device + metadata/allowlist) ---

export interface ShareRow {
  share_uid: string;
  linked_device_id: number;
  entry_ids: string;
  entry_ids_flat: string;
  description: string | null;
  expires_at: string | null;
  visit_count: number;
  created_at: string;
}

/** Get per-user library selections for a user+server. Returns list of selected library IDs, or null if none set (= all libraries). */
export function getUserLibrarySettings(key: UserKey): string[] | null {
  assertUserKey(key);
  const database = openDb();
  const row = database
    .prepare("SELECT selected_ids FROM user_library_settings WHERE subsonic_username = ? AND jellyfin_url = ?")
    .get(key.subsonicUsername, key.jellyfinUrl) as { selected_ids: string } | undefined;
  if (!row) return null;
  try {
    const ids = JSON.parse(row.selected_ids) as string[];
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

/** Set per-user library selections for a user+server. Pass empty array to clear (= all libraries). */
export function setUserLibrarySettings(key: UserKey, selectedIds: string[]): void {
  assertUserKey(key);
  const database = openDb();
  const updatedAt = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO user_library_settings (subsonic_username, jellyfin_url, selected_ids, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(subsonic_username, jellyfin_url) DO UPDATE SET
         selected_ids = excluded.selected_ids,
         updated_at = excluded.updated_at`
    )
    .run(key.subsonicUsername, key.jellyfinUrl, JSON.stringify(selectedIds), updatedAt);
}

/** Create a share: one linked device + one shares row. Returns shareUid and the app password (secret).
 * Pass jellyfinDeviceId and jellyfinDeviceName when the token was obtained via Quick Connect
 * so the share's Jellyfin requests use that device (shows as distinct in Jellyfin dashboard). */
export function createShare(
  key: UserKey,
  jellyfinUserId: string,
  jellyfinAccessToken: string,
  opts: {
    entryIds: string[];
    entryIdsFlat: string[];
    description?: string | null;
    expiresAt?: number | null;
    jellyfinDeviceId?: string;
    jellyfinDeviceName?: string;
  }
): { shareUid: string; secret: string; linkedDeviceId: number } {
  assertUserKey(key);
  const database = openDb();
  const shareUid = randomUUID();
  const description = opts.description?.trim() || null;
  const deviceLabel = description ? `SHARE: ${description}` : "SHARE: Share";
  const secret = addLinkedDevice(
    key,
    jellyfinUserId,
    jellyfinAccessToken,
    deviceLabel,
    opts.jellyfinDeviceId,
    opts.jellyfinDeviceName
  );
  const deviceRow = database
    .prepare("SELECT id FROM linked_devices WHERE subsonic_username = ? AND jellyfin_url = ? ORDER BY id DESC LIMIT 1")
    .get(key.subsonicUsername, key.jellyfinUrl) as { id: number } | undefined;
  if (!deviceRow) throw new Error("Failed to get created device id");
  const linkedDeviceId = deviceRow.id;
  const expiresAt =
    opts.expiresAt != null && opts.expiresAt > 0 ? new Date(opts.expiresAt).toISOString() : null;
  const cfg = getConfig();
  const secretEnc = encrypt(secret, cfg);
  database
    .prepare(
      `INSERT INTO shares (share_uid, linked_device_id, entry_ids, entry_ids_flat, description, expires_at, visit_count, created_at, share_secret_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)`
    )
    .run(
      shareUid,
      linkedDeviceId,
      JSON.stringify(opts.entryIds),
      JSON.stringify(opts.entryIdsFlat),
      description,
      expiresAt,
      secretEnc
    );
  return { shareUid, secret, linkedDeviceId };
}

/** Get share by public uid, with linked device's subsonic_username (owner). */
export function getShareByUid(
  shareUid: string
): (ShareRow & { subsonic_username: string }) | null {
  const database = openDb();
  const row = database
    .prepare(
      `SELECT s.share_uid, s.linked_device_id, s.entry_ids, s.entry_ids_flat, s.description, s.expires_at, s.visit_count, s.created_at, d.subsonic_username
       FROM shares s JOIN linked_devices d ON d.id = s.linked_device_id WHERE s.share_uid = ?`
    )
    .get(shareUid) as (ShareRow & { subsonic_username: string }) | undefined;
  return row ?? null;
}

export interface ShareWithUrl extends ShareRow {
  fullUrl: string | null;
}

/** List shares owned by the given user. fullUrl is set when the share secret was stored (new shares). */
export function getSharesForUser(subsonicUsername: string): ShareWithUrl[] {
  const database = openDb();
  const cfg = getConfig();
  const baseUrl = (cfg.subfinPublicUrl || `http://localhost:${cfg.port}`).replace(/\/$/, "");
  // Automatically drop expired shares (older than their explicit expires_at or older than 1 year by default)
  // so they do not linger indefinitely.
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const defaultCutoffIso = new Date(now - oneYearMs).toISOString();
  database
    .prepare(
      "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    )
    .run();
  database
    .prepare(
      "DELETE FROM shares WHERE expires_at IS NULL AND created_at < ?"
    )
    .run(defaultCutoffIso);
  const rows = database
    .prepare(
      `SELECT s.share_uid, s.linked_device_id, s.entry_ids, s.entry_ids_flat, s.description, s.expires_at, s.visit_count, s.created_at, s.share_secret_encrypted
       FROM shares s JOIN linked_devices d ON d.id = s.linked_device_id WHERE d.subsonic_username = ?
       ORDER BY s.created_at DESC`
    )
    .all(subsonicUsername) as (ShareRow & { share_secret_encrypted: Buffer | null })[];
  return rows.map((r) => {
    let fullUrl: string | null = null;
    if (r.share_secret_encrypted) {
      try {
        const secret = decrypt(r.share_secret_encrypted, cfg);
        fullUrl = `${baseUrl}/share/${r.share_uid}?secret=${encodeURIComponent(secret)}`;
      } catch {
        // ignore decryption failure
      }
    }
    const { share_secret_encrypted: _, ...rest } = r;
    return { ...rest, fullUrl };
  });
}

/** Update share description and/or expiry. Returns true if updated. */
export function updateShare(
  shareUid: string,
  subsonicUsername: string,
  opts: { description?: string | null; expiresAt?: number | null }
): boolean {
  const database = openDb();
  const share = getShareByUid(shareUid);
  if (!share || share.subsonic_username !== subsonicUsername) return false;
  const description =
    opts.description !== undefined ? (opts.description?.trim() || null) : share.description;
  const expiresAt =
    opts.expiresAt !== undefined
      ? opts.expiresAt != null && opts.expiresAt > 0
        ? new Date(opts.expiresAt).toISOString()
        : null
      : share.expires_at;
  database
    .prepare("UPDATE shares SET description = ?, expires_at = ? WHERE share_uid = ?")
    .run(description, expiresAt, shareUid);
  const deviceLabel = description ? `SHARE: ${description}` : `SHARE: Share ${shareUid.slice(0, 8)}`;
  database
    .prepare("UPDATE linked_devices SET device_label = ? WHERE id = ? AND subsonic_username = ?")
    .run(deviceLabel, share.linked_device_id, subsonicUsername);
  return true;
}

/** Delete share and unlink the associated device (revoke password). Returns true if deleted. */
export function deleteShare(shareUid: string, subsonicUsername: string): boolean {
  const share = getShareByUid(shareUid);
  if (!share || share.subsonic_username !== subsonicUsername) return false;
  const database = openDb();
  database.prepare("DELETE FROM shares WHERE share_uid = ?").run(shareUid);
  const unlinked = unlinkDevice(share.linked_device_id, subsonicUsername);
  return unlinked;
}

/** Resolve share access by (share_uid, secret). Checks expiry. Returns credentials + allowed track ids or null. */
export function resolveShareAuth(
  shareUid: string,
  secret: string
): {
  subsonicUsername: string;
  jellyfinUrl: string;
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  linkedDeviceId: number;
  allowedTrackIds: Set<string>;
  description: string | null;
  expiresAt: string | null;
  jellyfinDeviceId?: string;
  jellyfinDeviceName?: string;
} | null {
  const share = getShareByUid(shareUid);
  if (!share) return null;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return null;
  const database = openDb();
  const deviceRow = database
    .prepare(
      "SELECT jellyfin_url, app_password_hash, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, jellyfin_device_id, jellyfin_device_name FROM linked_devices WHERE id = ?"
    )
    .get(share.linked_device_id) as
    | {
        jellyfin_url: string;
        app_password_hash: string;
        app_password_encrypted: Buffer;
        jellyfin_user_id: string;
        jellyfin_access_token_encrypted: Buffer;
        jellyfin_device_id: string | null;
        jellyfin_device_name: string | null;
      }
    | undefined;
  if (!deviceRow) return null;
  const cfg = getConfig();
  const passwordMatch = bcrypt.compareSync(secret, deviceRow.app_password_hash);
  if (!passwordMatch) return null;
  const jellyfinAccessToken = decrypt(deviceRow.jellyfin_access_token_encrypted, cfg);
  let allowedTrackIds: string[];
  try {
    allowedTrackIds = JSON.parse(share.entry_ids_flat) as string[];
    if (!Array.isArray(allowedTrackIds)) allowedTrackIds = [];
  } catch {
    allowedTrackIds = [];
  }
  return {
    subsonicUsername: share.subsonic_username,
    jellyfinUrl: deviceRow.jellyfin_url,
    jellyfinUserId: deviceRow.jellyfin_user_id,
    jellyfinAccessToken,
    linkedDeviceId: share.linked_device_id,
    allowedTrackIds: new Set(allowedTrackIds),
    description: share.description,
    expiresAt: share.expires_at,
    jellyfinDeviceId: deviceRow.jellyfin_device_id ?? undefined,
    jellyfinDeviceName: deviceRow.jellyfin_device_name ?? undefined,
  };
}

/** Get share credentials and allowlist by share_uid only (no secret check). For use when auth was already validated e.g. via share cookie. Checks expiry. */
export function getShareAuthByUid(shareUid: string): {
  subsonicUsername: string;
  jellyfinUrl: string;
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  allowedTrackIds: Set<string>;
  jellyfinDeviceId?: string;
  jellyfinDeviceName?: string;
} | null {
  const share = getShareByUid(shareUid);
  if (!share) return null;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return null;
  const database = openDb();
  const deviceRow = database
    .prepare(
      "SELECT jellyfin_url, jellyfin_user_id, jellyfin_access_token_encrypted, jellyfin_device_id, jellyfin_device_name FROM linked_devices WHERE id = ?"
    )
    .get(share.linked_device_id) as
    | {
        jellyfin_url: string;
        jellyfin_user_id: string;
        jellyfin_access_token_encrypted: Buffer;
        jellyfin_device_id: string | null;
        jellyfin_device_name: string | null;
      }
    | undefined;
  if (!deviceRow) return null;
  const jellyfinAccessToken = decrypt(deviceRow.jellyfin_access_token_encrypted, getConfig());
  let allowedTrackIds: string[] = [];
  try {
    allowedTrackIds = JSON.parse(share.entry_ids_flat) as string[];
    if (!Array.isArray(allowedTrackIds)) allowedTrackIds = [];
  } catch {
    allowedTrackIds = [];
  }
  return {
    subsonicUsername: share.subsonic_username,
    jellyfinUrl: deviceRow.jellyfin_url,
    jellyfinUserId: deviceRow.jellyfin_user_id,
    jellyfinAccessToken,
    allowedTrackIds: new Set(allowedTrackIds),
    jellyfinDeviceId: deviceRow.jellyfin_device_id ?? undefined,
    jellyfinDeviceName: deviceRow.jellyfin_device_name ?? undefined,
  };
}

/** Increment visit_count for a share. */
export function incrementShareVisitCount(shareUid: string): void {
  const database = openDb();
  database.prepare("UPDATE shares SET visit_count = visit_count + 1 WHERE share_uid = ?").run(shareUid);
}

/** Ensure store is initialized (call on startup). */
export function getDb(): void {
  openDb();
}

export function initDb(): void {
  openDb();
  console.log("Store initialized at", getDbPath());
}
