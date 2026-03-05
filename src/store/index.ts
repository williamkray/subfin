/**
 * Token and app-password store. SQLite with encrypted sensitive columns (key from config salt).
 * One-time migration from legacy JSON store if present.
 */
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import { randomFillSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config/load.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "./crypto.js";

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
  return db;
}

function runSchema(database: Database.Database): void {
  const schemaPath = resolve(__dirname, "schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");
  database.exec(sql);
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

function generateAppPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const bytes = new Uint8Array(24);
  randomFillSync(bytes);
  for (let i = 0; i < 24; i++) s += chars[bytes[i]! % chars.length];
  return s;
}

/** Add a linked device; returns the plain app password (show once). */
export function addLinkedDevice(
  subsonicUsername: string,
  jellyfinUserId: string,
  jellyfinAccessToken: string,
  deviceLabel?: string
): string {
  const cfg = getConfig();
  const database = openDb();
  const plainPassword = generateAppPassword();
  const hash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
  const appEnc = encrypt(plainPassword, cfg);
  const tokenEnc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO linked_devices (subsonic_username, app_password_hash, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(subsonicUsername, hash, appEnc, jellyfinUserId, tokenEnc, deviceLabel ?? null, created);
  return plainPassword;
}

/** Resolve Subsonic (username, password) to Jellyfin token and matched device. */
export function resolveToJellyfinToken(
  subsonicUsername: string,
  password: string
): {
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  deviceId: number;
  deviceLabel: string | null;
} | null {
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, jellyfin_user_id, app_password_hash, jellyfin_access_token_encrypted, device_label FROM linked_devices WHERE subsonic_username = ?"
    )
    .all(subsonicUsername) as {
      id: number;
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
        deviceId: row.id,
        deviceLabel: row.device_label,
      };
    }
  }
  return null;
}

/** Get Jellyfin credentials for a user who already has a linked device. */
export function getJellyfinCredentialsForUser(
  subsonicUsername: string
): { jellyfinUserId: string; jellyfinAccessToken: string } | null {
  const database = openDb();
  // Prefer explicit Jellyfin session (auth-only step), fall back to any linked device.
  const sessionRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM jellyfin_sessions WHERE subsonic_username = ?"
    )
    .get(subsonicUsername) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;

  const cfg = getConfig();

  if (sessionRow) {
    const token = decrypt(sessionRow.jellyfin_access_token_encrypted, cfg);
    return { jellyfinUserId: sessionRow.jellyfin_user_id, jellyfinAccessToken: token };
  }

  const deviceRow = database
    .prepare(
      "SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM linked_devices WHERE subsonic_username = ? LIMIT 1"
    )
    .get(subsonicUsername) as
    | { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer }
    | undefined;
  if (!deviceRow) return null;
  const token = decrypt(deviceRow.jellyfin_access_token_encrypted, cfg);
  return { jellyfinUserId: deviceRow.jellyfin_user_id, jellyfinAccessToken: token };
}

/** Return the first linked device's Subsonic username, or null if none. Used by debug scripts to resolve credentials from the DB. */
export function getFirstSubsonicUsername(): string | null {
  const database = openDb();
  const row = database
    .prepare("SELECT subsonic_username FROM linked_devices ORDER BY created_at ASC LIMIT 1")
    .get() as { subsonic_username: string } | undefined;
  return row?.subsonic_username ?? null;
}

/** List linked devices for a Subsonic username. */
export function listLinkedDevices(
  subsonicUsername: string
): Omit<LinkedDevice, "app_password_hash">[] {
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, subsonic_username, jellyfin_user_id, device_label, created_at FROM linked_devices WHERE subsonic_username = ? ORDER BY created_at DESC"
    )
    .all(subsonicUsername) as { id: number; subsonic_username: string; jellyfin_user_id: string; device_label: string | null; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    subsonic_username: r.subsonic_username,
    jellyfin_user_id: r.jellyfin_user_id,
    device_label: r.device_label,
    created_at: r.created_at,
  }));
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

/** Internal: devices for a user including plain app password (for token auth). */
export function getDevicesForToken(subsonicUsername: string): LinkedDeviceForToken[] {
  const database = openDb();
  const rows = database
    .prepare(
      "SELECT id, subsonic_username, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted, device_label FROM linked_devices WHERE subsonic_username = ?"
    )
    .all(subsonicUsername) as {
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

/** Store pending QuickConnect result. */
export function setPendingQuickConnect(
  secret: string,
  jellyfinUserId: string,
  jellyfinAccessToken: string
): void {
  const cfg = getConfig();
  const database = openDb();
  const enc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  database
    .prepare(
      "INSERT OR REPLACE INTO pending_quickconnect (secret, jellyfin_user_id, jellyfin_access_token_encrypted, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(secret, jellyfinUserId, enc, created);
}

/** Get and remove pending QuickConnect result. */
export function consumePendingQuickConnect(
  secret: string
): { jellyfinUserId: string; jellyfinAccessToken: string } | null {
  const database = openDb();
  const row = database
    .prepare("SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM pending_quickconnect WHERE secret = ?")
    .get(secret) as { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer } | undefined;
  if (!row) return null;
  database.prepare("DELETE FROM pending_quickconnect WHERE secret = ?").run(secret);
  const cfg = getConfig();
  const token = decrypt(row.jellyfin_access_token_encrypted, cfg);
  return { jellyfinUserId: row.jellyfin_user_id, jellyfinAccessToken: token };
}

/** Invalidate all stored tokens for a Jellyfin user. */
export function invalidateTokensForJellyfinUser(jellyfinUserId: string): void {
  const database = openDb();
  database.prepare("DELETE FROM linked_devices WHERE jellyfin_user_id = ?").run(jellyfinUserId);
  database.prepare("DELETE FROM jellyfin_sessions WHERE jellyfin_user_id = ?").run(jellyfinUserId);
}

/** Store a Jellyfin session for a Subsonic username (auth step without linking a device). */
export function setJellyfinSession(
  subsonicUsername: string,
  jellyfinUserId: string,
  jellyfinAccessToken: string
): void {
  const cfg = getConfig();
  const database = openDb();
  const enc = encrypt(jellyfinAccessToken, cfg);
  const created = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO jellyfin_sessions (subsonic_username, jellyfin_user_id, jellyfin_access_token_encrypted, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(subsonic_username) DO UPDATE SET
         jellyfin_user_id = excluded.jellyfin_user_id,
         jellyfin_access_token_encrypted = excluded.jellyfin_access_token_encrypted,
         created_at = excluded.created_at`
    )
    .run(subsonicUsername, jellyfinUserId, enc, created);
}

/** Ensure store is initialized (call on startup). */
export function getDb(): void {
  openDb();
}

export function initDb(): void {
  openDb();
  console.log("Store initialized at", getDbPath());
}
