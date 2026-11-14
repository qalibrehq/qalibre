/**
 * Spotting secrets pasted into a chat by mistake. Scammers ask people to "send your key to verify"; when someone
 * does, the bot deletes the message at once and tells them to treat the secret as exposed.
 *
 * Detection is exact where it can be (agent keys, recovery phrases against the official BIP-39 word list) and
 * deliberately cautious where it cannot: a 64-hex string may be a transaction hash, but deleting one costs nothing,
 * while leaving a private key in a chat can cost everything.
 */
import { english } from 'viem/accounts';

const WORDS = new Set(english);
const AGENT_KEY = /qak_[A-Za-z0-9_-]{43}/g;
// 64 hex characters, optionally 0x-prefixed, not part of a longer hex run (a 40-hex address never matches).
const PRIVATE_KEY = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

export type SecretKind = 'agent_key' | 'private_key' | 'recovery_phrase';

/** Longest run of consecutive BIP-39 words in the text. */
function longestWordRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (!w) continue;
    if (WORDS.has(w)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

export function detectSecret(text: string): { kind: SecretKind; agentKeys: string[] } | null {
  const agentKeys = text.match(AGENT_KEY) ?? [];
  if (agentKeys.length) return { kind: 'agent_key', agentKeys };
  if (PRIVATE_KEY.test(text)) return { kind: 'private_key', agentKeys: [] };
  // Ordinary English is full of BIP-39 words ("able", "about", "account"), but twelve or more in a row, with
  // nothing else between them, is a recovery phrase.
  if (longestWordRun(text) >= PHRASE_LENGTHS[0]!) return { kind: 'recovery_phrase', agentKeys: [] };
  return null;
}

export const SECRET_WARNING: Record<SecretKind, string> = {
  private_key:
    '<b>I deleted your message.</b> It looked like a private key. Never share a private key with anyone, including us; Qalibre will never ask for it.\n\nIf it was a real key, treat it as exposed and move any funds it controls to a new wallet now.',
  recovery_phrase:
    '<b>I deleted your message.</b> It looked like a recovery phrase. Never share it with anyone, including us; Qalibre will never ask for it.\n\nIf it was real, treat it as exposed and move your funds to a new wallet now.',
  agent_key:
    '<b>I deleted your message and revoked that agent key.</b> Agent keys belong only in your AI agent\'s settings. Create a new one with /agent.',
};

export const GROUP_WARNING = '<b>A message here looked like a private key or recovery phrase.</b> Never post one anywhere. Anyone asking for it is trying to steal from you. Qalibre never asks.';
