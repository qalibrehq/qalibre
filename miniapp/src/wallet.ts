/**
 * The owner key: created on this device, encrypted with the user's PIN, stored in the user's own
 * Telegram CloudStorage (synced to their Telegram account) and in local storage.
 * It is never sent to Qalibre's servers. Only its address and signatures leave the device.
 *
 * Encryption: PBKDF2-SHA256 (600,000 iterations) derives an AES-256-GCM key from the PIN.
 */
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { cloud } from './tg';

const STORE_KEY = 'qalibre_owner_v1';
const ITERATIONS = 600_000;

interface Vault {
  v: 1;
  address: string;
  salt: string;
  iv: string;
  ct: string;
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function loadVault(): Promise<Vault | null> {
  const raw = await cloud.get(STORE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Vault;
    return v.v === 1 ? v : null;
  } catch {
    return null;
  }
}

/** Create a new owner key and store it encrypted. Returns the unlocked account. */
export async function createOwner(pin: string): Promise<PrivateKeyAccount> {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(account.address) }, key, new TextEncoder().encode(pk));
  const vault: Vault = { v: 1, address: account.address, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  await cloud.set(STORE_KEY, JSON.stringify(vault));
  return account;
}

export class WrongPin extends Error {}

export async function unlockOwner(pin: string): Promise<PrivateKeyAccount> {
  const vault = await loadVault();
  if (!vault) throw new Error('No wallet key on this device.');
  const key = await deriveKey(pin, unb64(vault.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv), additionalData: new TextEncoder().encode(vault.address) }, key, unb64(vault.ct));
    return privateKeyToAccount(new TextDecoder().decode(pt) as Hex);
  } catch {
    throw new WrongPin('That PIN is not right.');
  }
}

/** For the backup screen: the raw key, shown only after unlocking with the PIN. */
export async function exportKey(pin: string): Promise<Hex> {
  const vault = await loadVault();
  if (!vault) throw new Error('No wallet key on this device.');
  const key = await deriveKey(pin, unb64(vault.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv), additionalData: new TextEncoder().encode(vault.address) }, key, unb64(vault.ct));
  return new TextDecoder().decode(pt) as Hex;
}

const BACKUP_KEY = 'qalibre_backed_up_v1';
/** Whether the user has confirmed saving their key. Until then the home screen keeps asking. */
export async function isBackedUp(): Promise<boolean> {
  return (await cloud.get(BACKUP_KEY)) === '1';
}
export function markBackedUp(): Promise<void> {
  return cloud.set(BACKUP_KEY, '1');
}
