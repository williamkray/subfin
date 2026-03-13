import { scryptSync, createDecipheriv } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const KEY_LEN = 32
const IV_LEN = 12
const AUTH_TAG_LEN = 16
// Must match SCRIPT_SALT in src/store/crypto.ts
const SCRYPT_SALT = 'subfin-db-encryption-v1'

export function parseSalt(saltRaw: string): Buffer {
  const trimmed = saltRaw.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  return Buffer.from(trimmed, 'base64')
}

export function deriveKey(saltBuf: Buffer): Buffer {
  return scryptSync(saltBuf, SCRYPT_SALT, KEY_LEN) as Buffer
}

export function decryptBlob(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN)
  const authTag = blob.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN)
  const ciphertext = blob.subarray(IV_LEN + AUTH_TAG_LEN)
  const d = createDecipheriv(ALGO, key, iv)
  d.setAuthTag(authTag)
  return d.update(ciphertext).toString('utf8') + d.final('utf8')
}
