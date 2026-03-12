import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { parseSalt, deriveKey, decryptBlob } from './crypto'

export function extractCredentials(): {
  username: string
  password: string
  jellyfinUserId: string
  jellyfinToken: string
  jellyfinBaseUrl: string
} {
  const config = JSON.parse(readFileSync('data/subfin.config.json', 'utf-8')) as {
    salt: string
    jellyfin?: { baseUrl?: string }
    jellyfinUrl?: string
  }
  const key = deriveKey(parseSalt(config.salt))
  const db = new Database('data/subfin.db', { readonly: true })
  const row = db
    .prepare(
      `SELECT subsonic_username, app_password_encrypted,
              jellyfin_user_id, jellyfin_access_token_encrypted
       FROM linked_devices ORDER BY created_at ASC LIMIT 1`
    )
    .get() as {
    subsonic_username: string
    app_password_encrypted: Buffer
    jellyfin_user_id: string
    jellyfin_access_token_encrypted: Buffer
  }
  db.close()
  return {
    username: row.subsonic_username,
    password: decryptBlob(row.app_password_encrypted, key),
    jellyfinUserId: row.jellyfin_user_id,
    jellyfinToken: decryptBlob(row.jellyfin_access_token_encrypted, key),
    jellyfinBaseUrl: (config.jellyfin?.baseUrl ?? config.jellyfinUrl ?? '').replace(/\/$/, ''),
  }
}
