import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Symmetric encryption helpers for sensitive values at rest (GitHub OAuth tokens).
 *
 * Format: `v1.<iv b64url>.<authTag b64url>.<ciphertext b64url>`
 * Values without the `v1.` prefix are treated as legacy plaintext and passed
 * through unchanged so existing rows keep working.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  // Deriving a fixed-length key from the configured secret keeps operator setup simple.
  return crypto.createHash('sha256').update(env.TOKEN_ENCRYPTION_KEY).digest();
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }

  const parts = stored.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted secret');
  }

  const [, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Returns a non-reversible fingerprint of a token for logs. */
export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}
