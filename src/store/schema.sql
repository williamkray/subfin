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
