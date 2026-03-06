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

/** Save play queue for a user (OpenSubsonic savePlayQueue). Replaces any existing queue. */
export function savePlayQueue(
  subsonicUsername: string,
  data: { entryIds: string[]; currentId: string | null; positionMs: number; changedBy: string }
): void {
  const database = openDb();
  const changedAt = new Date().toISOString();
  const entryIdsJson = JSON.stringify(data.entryIds);
  database
    .prepare(
      `INSERT INTO play_queue (subsonic_username, entry_ids, current_id, position_ms, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(subsonic_username) DO UPDATE SET
         entry_ids = excluded.entry_ids,
         current_id = excluded.current_id,
         position_ms = excluded.position_ms,
         changed_at = excluded.changed_at,
         changed_by = excluded.changed_by`
    )
    .run(
      subsonicUsername,
      entryIdsJson,
      data.currentId ?? null,
      Math.max(0, data.positionMs),
      changedAt,
      data.changedBy?.trim().slice(0, 255) ?? ""
    );
}

/** Get saved play queue for a user, or null if none. */
export function getPlayQueue(subsonicUsername: string): {
  entryIds: string[];
  currentId: string | null;
  positionMs: number;
  changedAt: string;
  changedBy: string;
} | null {
  const database = openDb();
  const row = database
    .prepare(
      "SELECT entry_ids, current_id, position_ms, changed_at, changed_by FROM play_queue WHERE subsonic_username = ?"
    )
    .get(subsonicUsername) as
    | { entry_ids: string; current_id: string | null; position_ms: number; changed_at: string; changed_by: string }
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
    positionMs: Math.max(0, row.position_ms),
    changedAt: row.changed_at,
    changedBy: row.changed_by ?? "",
  };
}

/** Clear saved play queue for a user (savePlayQueue with no ids). */
export function clearPlayQueue(subsonicUsername: string): void {
  const database = openDb();
  database.prepare("DELETE FROM play_queue WHERE subsonic_username = ?").run(subsonicUsername);
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

/** Create a share: one linked device + one shares row. Returns shareUid and the app password (secret). */
export function createShare(
  subsonicUsername: string,
  jellyfinUserId: string,
  jellyfinAccessToken: string,
  opts: {
    entryIds: string[];
    entryIdsFlat: string[];
    description?: string | null;
    expiresAt?: number | null;
  }
): { shareUid: string; secret: string; linkedDeviceId: number } {
  const database = openDb();
  const shareUid = randomUUID();
  const description = opts.description?.trim() || null;
  const deviceLabel = description ? `SHARE: ${description}` : "SHARE: Share";
  const secret = addLinkedDevice(subsonicUsername, jellyfinUserId, jellyfinAccessToken, deviceLabel);
  const deviceRow = database
    .prepare("SELECT id FROM linked_devices WHERE subsonic_username = ? ORDER BY id DESC LIMIT 1")
    .get(subsonicUsername) as { id: number } | undefined;
  if (!deviceRow) throw new Error("Failed to get created device id");
  const linkedDeviceId = deviceRow.id;
  const expiresAt =
    opts.expiresAt != null && opts.expiresAt > 0 ? new Date(opts.expiresAt).toISOString() : null;
  database
    .prepare(
      `INSERT INTO shares (share_uid, linked_device_id, entry_ids, entry_ids_flat, description, expires_at, visit_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`
    )
    .run(
      shareUid,
      linkedDeviceId,
      JSON.stringify(opts.entryIds),
      JSON.stringify(opts.entryIdsFlat),
      description,
      expiresAt
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

/** List shares owned by the given user. */
export function getSharesForUser(subsonicUsername: string): ShareRow[] {
  const database = openDb();
  const rows = database
    .prepare(
      `SELECT s.share_uid, s.linked_device_id, s.entry_ids, s.entry_ids_flat, s.description, s.expires_at, s.visit_count, s.created_at
       FROM shares s JOIN linked_devices d ON d.id = s.linked_device_id WHERE d.subsonic_username = ?
       ORDER BY s.created_at DESC`
    )
    .all(subsonicUsername) as ShareRow[];
  return rows;
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
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  linkedDeviceId: number;
  allowedTrackIds: Set<string>;
  description: string | null;
  expiresAt: string | null;
} | null {
  const share = getShareByUid(shareUid);
  if (!share) return null;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return null;
  const database = openDb();
  const deviceRow = database
    .prepare(
      "SELECT app_password_hash, app_password_encrypted, jellyfin_user_id, jellyfin_access_token_encrypted FROM linked_devices WHERE id = ?"
    )
    .get(share.linked_device_id) as
    | {
        app_password_hash: string;
        app_password_encrypted: Buffer;
        jellyfin_user_id: string;
        jellyfin_access_token_encrypted: Buffer;
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
    jellyfinUserId: deviceRow.jellyfin_user_id,
    jellyfinAccessToken,
    linkedDeviceId: share.linked_device_id,
    allowedTrackIds: new Set(allowedTrackIds),
    description: share.description,
    expiresAt: share.expires_at,
  };
}

/** Get share credentials and allowlist by share_uid only (no secret check). For use when auth was already validated e.g. via share cookie. Checks expiry. */
export function getShareAuthByUid(shareUid: string): {
  subsonicUsername: string;
  jellyfinUserId: string;
  jellyfinAccessToken: string;
  allowedTrackIds: Set<string>;
} | null {
  const share = getShareByUid(shareUid);
  if (!share) return null;
  if (share.expires_at && new Date(share.expires_at) < new Date()) return null;
  const database = openDb();
  const deviceRow = database
    .prepare("SELECT jellyfin_user_id, jellyfin_access_token_encrypted FROM linked_devices WHERE id = ?")
    .get(share.linked_device_id) as { jellyfin_user_id: string; jellyfin_access_token_encrypted: Buffer } | undefined;
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
    jellyfinUserId: deviceRow.jellyfin_user_id,
    jellyfinAccessToken,
    allowedTrackIds: new Set(allowedTrackIds),
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
