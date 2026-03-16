-- Linked devices: each row = one app-specific password (one "device") for a Subsonic client.
-- Sensitive values stored encrypted (key derived from config salt).
CREATE TABLE IF NOT EXISTS linked_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subsonic_username TEXT NOT NULL,
  jellyfin_url TEXT NOT NULL DEFAULT '',
  app_password_hash TEXT NOT NULL,
  app_password_encrypted BLOB NOT NULL,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_access_token_encrypted BLOB NOT NULL,
  device_label TEXT,
  jellyfin_device_id TEXT,
  jellyfin_device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_linked_devices_username ON linked_devices(subsonic_username);
CREATE INDEX IF NOT EXISTS idx_linked_devices_jellyfin_user ON linked_devices(jellyfin_user_id);
-- NOTE: idx_linked_devices_username_url is created by the migration in runSchema() after
-- the jellyfin_url column is guaranteed to exist (ALTER TABLE for upgrades, or present on fresh install).

-- Pending QuickConnect: secret -> encrypted jellyfin token; cleaned after use or expiry.
CREATE TABLE IF NOT EXISTS pending_quickconnect (
  secret TEXT PRIMARY KEY,
  jellyfin_url TEXT NOT NULL DEFAULT '',
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_access_token_encrypted BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jellyfin sessions: store Jellyfin token per (Subsonic username, Jellyfin URL) after auth,
-- independent of any specific linked device. Device linking uses this as the
-- source of truth for Jellyfin credentials when generating app passwords.
-- NOTE: composite PK. Migration in runSchema() recreates this table if needed.
CREATE TABLE IF NOT EXISTS jellyfin_sessions (
  subsonic_username TEXT NOT NULL,
  jellyfin_url TEXT NOT NULL DEFAULT '',
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_access_token_encrypted BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subsonic_username, jellyfin_url)
);

-- Saved play queue per (user, Jellyfin URL) (OpenSubsonic savePlayQueue/getPlayQueue).
-- One queue per user+server so any device on that server can save and restore.
-- NOTE: composite PK. Migration in runSchema() recreates this table if needed.
CREATE TABLE IF NOT EXISTS play_queue (
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

-- Per-user library selection: which Jellyfin music libraries to show in Subsonic clients.
-- Empty selected_ids = no restriction (all libraries).
CREATE TABLE IF NOT EXISTS user_library_settings (
  subsonic_username TEXT NOT NULL,
  jellyfin_url TEXT NOT NULL,
  selected_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subsonic_username, jellyfin_url)
);

-- Shares: public share = one linked device (share device) + metadata and allowlist.
-- share_uid is UUID for public URLs (unguessable); linked_device_id is FK to the share device.
CREATE TABLE IF NOT EXISTS shares (
  share_uid TEXT PRIMARY KEY,
  linked_device_id INTEGER NOT NULL UNIQUE,
  entry_ids TEXT NOT NULL,
  entry_ids_flat TEXT NOT NULL,
  description TEXT,
  expires_at TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (linked_device_id) REFERENCES linked_devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_linked_device ON shares(linked_device_id);

-- Cached derived views for performance (e.g. artist index built from Jellyfin albums).
-- cache_key is an opaque string that encodes the parameters (user, folder set, view type).
-- last_source_change_at tracks the backend library's last-modified signal (e.g. newest album date)
-- observed when the cache was built; it can be used alongside TTL to decide when to refresh.
CREATE TABLE IF NOT EXISTS derived_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  cached_at TEXT NOT NULL,
  last_source_change_at TEXT
);
