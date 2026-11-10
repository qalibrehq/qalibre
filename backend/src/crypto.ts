/**
 * Session keys are the only keys Qalibre holds, and they can only place capped trades into the
 * user's own account. They are still encrypted at rest with AES-256-GCM so a database leak alone
 * reveals nothing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(hex: string): Buffer {
  const k = Buffer.from(hex, 'hex');
  if (k.length !== 32) throw new Error('SESSION_ENC_KEY must be 32 bytes hex');
  return k;
}

/** Returns "v1:<iv>:<tag>:<ciphertext>" (base64 parts). `aad` binds the ciphertext to a user. */
export function encrypt(plaintext: string, keyHex: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(keyHex), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob: string, keyHex: string, aad: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key(keyHex), Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
