/**
 * Encrypt/decrypt sensitive values for DB storage using key derived from config salt.
 * AES-256-GCM; IV (12) + authTag (16) + ciphertext stored as BLOB.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Config } from "../config/load.js";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const SCRIPT_SALT = "subfin-db-encryption-v1";

let cachedKey: Buffer | null = null;

function getKey(config: Config): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = scryptSync(config.salt, SCRIPT_SALT, KEY_LEN);
  return cachedKey;
}

export function encrypt(plaintext: string, config: Config): Buffer {
  const key = getKey(config);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, enc]);
}

export function decrypt(blob: Buffer, config: Config): string {
  if (blob.length < IV_LEN + AUTH_TAG_LEN) {
    throw new Error("Invalid encrypted blob");
  }
  const key = getKey(config);
  const iv = blob.subarray(0, IV_LEN);
  const authTag = blob.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}
