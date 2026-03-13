-- Linked devices: each row = one app-specific password (one "device") for a Subsonic client.
-- Sensitive values stored encrypted (key derived from config salt).
CREATE TABLE IF NOT EXISTS linked_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subsonic_username TEXT NOT NULL,
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

-- Pending QuickConnect: secret -> encrypted jellyfin token; cleaned after use or expiry.
CREATE TABLE IF NOT EXISTS pending_quickconnect (
  secret TEXT PRIMARY KEY,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_access_token_encrypted BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jellyfin sessions: store Jellyfin token per Subsonic username after auth,
-- independent of any specific linked device. Device linking uses this as the
-- source of truth for Jellyfin credentials when generating app passwords.
CREATE TABLE IF NOT EXISTS jellyfin_sessions (
  subsonic_username TEXT PRIMARY KEY,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_access_token_encrypted BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved play queue per user (OpenSubsonic savePlayQueue/getPlayQueue). One queue per user so
-- any device can save and any device can restore (cross-device continuity).
CREATE TABLE IF NOT EXISTS play_queue (
  subsonic_username TEXT PRIMARY KEY,
  entry_ids TEXT NOT NULL,
  current_id TEXT,
  current_index INTEGER NOT NULL DEFAULT 0,
  position_ms INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT ''
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
