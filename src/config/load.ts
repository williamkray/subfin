/**
 * Configuration: optional JSON file + env overlay.
 * All settings (including salt for DB encryption) can come from file or env.
 * Salt is required for securing sensitive data in the database.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const env = process.env;

const CONFIG_PATH = env.SUBFIN_CONFIG ?? "subfin.config.json";

export interface JellyfinConfig {
  baseUrl: string;
  clientName: string;
  deviceId: string;
  deviceName: string;
}

export interface Config {
  port: number;
  subfinPublicUrl: string;
  jellyfin: JellyfinConfig;
  /** Allowed Jellyfin backend URLs. Non-empty = restricted mode; empty = open mode (SSRF mitigation required). */
  allowedJellyfinHosts: string[];
  dbPath: string;
  logRest: boolean;
  /** Optional Last.fm API key for enriching artist info (biography, last.fm URL). */
  lastFmApiKey?: string;
  /** Secret used to derive encryption key for sensitive DB fields. Required. From SUBFIN_SALT or config file. */
  salt: Buffer;
}

function loadFromFile(): Record<string, unknown> {
  const path = resolve(process.cwd(), CONFIG_PATH);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function getFromEnvOrFile(
  file: Record<string, unknown>,
  envKey: string,
  fileKey: string,
  nested?: string
): string | undefined {
  const envVal = env[envKey];
  if (envVal !== undefined && envVal !== "") return envVal;
  if (nested && file[nested]) {
    const inner = (file[nested] as Record<string, unknown>)[fileKey];
    if (typeof inner === "string") return inner;
  }
  const val = nested ? (file[nested] as Record<string, unknown>)?.[fileKey] : file[fileKey];
  if (typeof val === "string") return val;
  return undefined;
}

/**
 * Emit loud startup warnings for config values that are deprecated in this version.
 * Called once from loadConfig().
 */
function warnDeprecatedConfigKeys(file: Record<string, unknown>): void {
  const BORDER = "=".repeat(72);
  if (env.MUSIC_LIBRARY_IDS) {
    console.warn(
      `\n${BORDER}\n` +
      `DEPRECATION WARNING: MUSIC_LIBRARY_IDS environment variable is no longer\n` +
      `supported and has NO EFFECT. Library selection is now managed per-user\n` +
      `via the Subfin web UI (/). Remove MUSIC_LIBRARY_IDS from your environment.\n` +
      `${BORDER}\n`
    );
  }
  if (Array.isArray(file.musicLibraryIds) && (file.musicLibraryIds as unknown[]).length > 0) {
    console.warn(
      `\n${BORDER}\n` +
      `DEPRECATION WARNING: 'musicLibraryIds' in subfin.config.json is no longer\n` +
      `supported. Library selection has been automatically migrated to per-user\n` +
      `settings in the database. Remove 'musicLibraryIds' from your config file.\n` +
      `${BORDER}\n`
    );
  }
}

/**
 * Returns the legacy musicLibraryIds from the config file or MUSIC_LIBRARY_IDS env var.
 * Used once at DB startup to migrate old global library restrictions to per-user settings.
 * Returns null if neither source has any values set.
 */
export function getLegacyMusicLibraryIds(): string[] | null {
  const file = loadFromFile();
  if (Array.isArray(file.musicLibraryIds)) {
    const ids = (file.musicLibraryIds as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > 0) return ids;
  }
  if (env.MUSIC_LIBRARY_IDS) {
    const ids = env.MUSIC_LIBRARY_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return null;
}

function parseSalt(saltRaw: string): Buffer {
  const trimmed = saltRaw.trim();
  if (trimmed.length < 32) {
    throw new Error(
      "SUBFIN_SALT must be at least 32 characters (32+ bytes when base64/hex decoded). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length < 32) throw new Error("SUBFIN_SALT hex value must decode to at least 32 bytes.");
    return buf;
  }
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length < 32) throw new Error("SUBFIN_SALT base64 value must decode to at least 32 bytes.");
  return buf;
}

export function loadConfig(): Config {
  const file = loadFromFile();
  const jellyfinFile = (file.jellyfin as Record<string, unknown>) ?? {};

  warnDeprecatedConfigKeys(file);

  const portStr = getFromEnvOrFile(file, "PORT", "port") ?? "4040";
  const subfinPublicUrl = (getFromEnvOrFile(file, "SUBFIN_PUBLIC_URL", "subfinPublicUrl") ?? "").replace(/\/$/, "");
  const jellyfinBaseUrl = (getFromEnvOrFile(file, "JELLYFIN_URL", "baseUrl", "jellyfin") ?? "http://localhost:8096").replace(/\/$/, "");
  const jellyfinClient = getFromEnvOrFile(file, "JELLYFIN_CLIENT", "clientName", "jellyfin") ?? "Subfin";
  const jellyfinDeviceId = getFromEnvOrFile(file, "JELLYFIN_DEVICE_ID", "deviceId", "jellyfin") ?? "subfin-device-1";
  const jellyfinDeviceName = getFromEnvOrFile(file, "JELLYFIN_DEVICE_NAME", "deviceName", "jellyfin") ?? "Subfin Middleware";
  // ALLOWED_JELLYFIN_HOSTS: comma-separated URLs. If not set, defaults to [jellyfinBaseUrl] for backward compat.
  const allowedJellyfinHostsRaw = getFromEnvOrFile(file, "ALLOWED_JELLYFIN_HOSTS", "allowedJellyfinHosts");
  let allowedJellyfinHosts: string[];
  if (allowedJellyfinHostsRaw !== undefined) {
    allowedJellyfinHosts = allowedJellyfinHostsRaw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  } else if (Array.isArray(file.allowedJellyfinHosts)) {
    allowedJellyfinHosts = (file.allowedJellyfinHosts as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);
  } else {
    // Backward compat: single-server deployments default to [JELLYFIN_URL] (restricted mode, one host).
    allowedJellyfinHosts = jellyfinBaseUrl ? [jellyfinBaseUrl] : [];
  }
  const dbPath = getFromEnvOrFile(file, "SUBFIN_DB_PATH", "dbPath") ?? "./subfin.db";
  const logRestRaw = getFromEnvOrFile(file, "SUBFIN_LOG_REST", "logRest");
  const logRest = logRestRaw === "true" || logRestRaw === "1" || file.logRest === true;
  const lastFmApiKey = getFromEnvOrFile(file, "LASTFM_API_KEY", "lastFmApiKey");

  const saltRaw = getFromEnvOrFile(file, "SUBFIN_SALT", "salt");
  if (!saltRaw || saltRaw.trim() === "") {
    throw new Error(
      "SUBFIN_SALT is required to secure data in the database. Set it in subfin.config.json (\"salt\": \"...\") or as environment variable SUBFIN_SALT. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const salt = parseSalt(saltRaw);

  return {
    port: parseInt(portStr, 10),
    subfinPublicUrl,
    jellyfin: {
      baseUrl: jellyfinBaseUrl,
      clientName: jellyfinClient,
      deviceId: jellyfinDeviceId,
      deviceName: jellyfinDeviceName,
    },
    allowedJellyfinHosts,
    dbPath,
    logRest,
    lastFmApiKey,
    salt,
  };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** True when no Jellyfin host allowlist is configured (open mode: any URL accepted, SSRF mitigation required). */
export function isOpenMode(): boolean {
  return getConfig().allowedJellyfinHosts.length === 0;
}
