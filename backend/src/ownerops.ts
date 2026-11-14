/**
 * Owner actions (turn trading off/on, edit limits, send funds) as ERC-4337 UserOperations.
 *
 * Trust model:
 *  - The phone encodes the call itself and signs only an operation whose hash it computed itself.
 *    The server never hands the phone a hash to sign.
 *  - The server adds gas sponsorship (VerifyingPaymaster signature) and submits through the EntryPoint.
 *  - Sponsorship policy: only calls on the user's own wallet, and only the owner actions listed below.
 *    Qalibre pays these network costs: we never charge users to protect or move their own money.
 */
import { decodeFunctionData, encodeAbiParameters, parseAbi, concat, pad, numberToHex, type Address, type Hex, isAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction';
import { config } from './config.js';
import { relay, relayer } from './relayer.js';
import { encrypt } from './crypto.js';
import type { Db } from './db.js';
import { UserError } from './service.js';
import { QalibreAccountAbi } from '../../solver/src/abi/QalibreAccount.js';
import { loadDeployment, publicClient, waitForConfirmations, walletClient } from '../../solver/src/chain.js';

const dep = loadDeployment() as ReturnType<typeof loadDeployment> & { paymaster: Address };
const client = publicClient();
// The relayer key sends through one queue with local nonces (src/relayer.ts).
const sponsor = privateKeyToAccount(config.sponsorKey);

const PACKED = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  `function handleOps(${PACKED}[] ops, address beneficiary)`,
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
const paymasterAbi = parseAbi([`function getHash(${PACKED} userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)`]);
const erc20TransferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

/** What Qalibre will sponsor. Anything else is refused before it costs anyone anything. */
function checkPolicy(account: Address, callData: Hex): { action: string; detail?: Record<string, string>; approved?: Address[] } {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: QalibreAccountAbi, data: callData });
  } catch {
    throw new UserError('That action is not supported.');
  }
  const fn = decoded.functionName;
  if (['revokeSession', 'setTokenLimit', 'setAnyBuyToken', 'setBuyTokenAllowed', 'setSession', 'setFastMode'].includes(fn)) return { action: fn };
  if (fn === 'executeBatch') {
    const [targets, values, datas] = decoded.args as readonly [readonly Address[], readonly bigint[], readonly Hex[]];
    const approved: Address[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (targets[i]!.toLowerCase() !== account.toLowerCase() || values[i] !== 0n) throw new UserError('That action is not supported.');
      const inner = decodeFunctionData({ abi: QalibreAccountAbi, data: datas[i]! });
      if (!['setTokenLimit', 'setAnyBuyToken', 'setBuyTokenAllowed', 'setFastMode'].includes(inner.functionName)) throw new UserError('That action is not supported.');
      if (inner.functionName === 'setBuyTokenAllowed' && (inner.args as readonly [Address, boolean])[1]) approved.push((inner.args as readonly [Address, boolean])[0]);
    }
    return approved.length ? { action: 'approveToken', approved } : { action: 'editLimits' };
  }
  if (fn === 'execute') {
    const [target, value, data] = decoded.args as readonly [Address, bigint, Hex];
    // Send native QMS to an address (no contract call), or send any token the wallet holds with a plain transfer.
    // Every token must be withdrawable by its owner, including ones bought through chat trading. Abuse of the
    // sponsorship is bounded by the per-user daily cap and the simulation before sending.
    if (data === '0x' && value > 0n) return { action: 'sendNative', detail: { to: target, amount: value.toString() } };
    if (value === 0n && target.toLowerCase() !== account.toLowerCase()) {
      const t = (() => {
        try {
          return decodeFunctionData({ abi: erc20TransferAbi, data });
        } catch {
          return null;
        }
      })();
      if (t?.functionName === 'transfer') return { action: 'sendToken', detail: { token: target, to: t.args[0], amount: t.args[1].toString() } };
    }
  }
  throw new UserError('That action is not supported.');
}

type Op = UserOperation<'0.7'>;
const toWire = (op: Op) => JSON.parse(JSON.stringify(op, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
function fromWire(w: Record<string, string>): Op {
  return {
    sender: w.sender as Address,
    nonce: BigInt(w.nonce!),
    callData: w.callData as Hex,
    callGasLimit: BigInt(w.callGasLimit!),
    verificationGasLimit: BigInt(w.verificationGasLimit!),
    preVerificationGas: BigInt(w.preVerificationGas!),
    maxFeePerGas: BigInt(w.maxFeePerGas!),
    maxPriorityFeePerGas: BigInt(w.maxPriorityFeePerGas!),
    paymaster: w.paymaster as Address,
    paymasterVerificationGasLimit: BigInt(w.paymasterVerificationGasLimit!),
    paymasterPostOpGasLimit: BigInt(w.paymasterPostOpGasLimit!),
    paymasterData: w.paymasterData as Hex,
    signature: (w.signature ?? '0x') as Hex,
  };
}

/** Called after an owner action has landed on-chain, so the chat can reflect it at once. */
export interface OwnerOpHooks {
  onApproved?: (tgId: number, tokens: Address[]) => void | Promise<void>;
}

export function createOwnerOps(db: Db, hooks: OwnerOpHooks = {}) {
  function accountOf(tgId: number): Address {
    const u = db.getUser(tgId);
    if (!u?.account || u.settlement?.toLowerCase() !== dep.settlement.toLowerCase()) throw new UserError('Open your wallet first.');
    return u.account as Address;
  }

  // Sponsorship budget: at most 20 sponsored owner actions per user per day, so the gas sponsor cannot be drained.
  const DAILY_SPONSORED = 20;
  const used = new Map<string, number>();
  function chargeBudget(tgId: number) {
    const key = `${tgId}:${Math.floor(Date.now() / 86_400_000)}`;
    const n = (used.get(key) ?? 0) + 1;
    if (n > DAILY_SPONSORED) throw new UserError('You have reached today\'s limit for wallet actions. Please try again tomorrow.');
    used.set(key, n);
  }

  /** Fill in gas, nonce and sponsorship for a call the phone encoded. The phone verifies and signs. */
  async function prepare(tgId: number, callData: Hex) {
    const sender = accountOf(tgId);
    chargeBudget(tgId);
    const policy = checkPolicy(sender, callData);
    const [nonce, block] = await Promise.all([
      client.readContract({ address: dep.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [sender, 0n] }),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    const base = block.baseFeePerGas ?? 0n;
    const validUntil = Math.floor(Date.now() / 1000) + 15 * 60;
    const op: Op = {
      sender,
      nonce,
      callData,
      callGasLimit: policy.action === 'setSession' ? 600_000n : 250_000n,
      verificationGasLimit: 150_000n,
      preVerificationGas: 60_000n,
      maxFeePerGas: base * 3n + 1_000n,
      maxPriorityFeePerGas: 1_000n,
      paymaster: dep.paymaster,
      paymasterVerificationGasLimit: 80_000n,
      paymasterPostOpGasLimit: 0n,
      paymasterData: '0x',
      signature: '0x',
    };
    // The paymaster's hash covers every field except its own data and the signature.
    const packed = toPackedUserOperation({ ...op, paymasterData: encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, 0]) });
    const h = await client.readContract({ address: dep.paymaster, abi: paymasterAbi, functionName: 'getHash', args: [packed, validUntil, 0] });
    const sponsorSig = await sponsor.signMessage({ message: { raw: h } });
    op.paymasterData = concat([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, 0]), sponsorSig]);
    return { op: toWire(op), entryPoint: dep.entryPoint, chainId: client.chain!.id, action: policy.action };
  }

  /** Submit an owner-signed operation through the EntryPoint (Qalibre acts as the bundler). */
  async function send(tgId: number, wire: Record<string, string>) {
    const sender = accountOf(tgId);
    const op = fromWire(wire);
    if (op.sender.toLowerCase() !== sender.toLowerCase()) throw new UserError('That wallet is not yours.');
    if (!op.paymaster || op.paymaster.toLowerCase() !== dep.paymaster.toLowerCase()) throw new UserError('Unexpected sponsor.');
    const policy = checkPolicy(sender, op.callData);
    const packed = toPackedUserOperation(op);
    try {
      await client.simulateContract({ address: dep.entryPoint, abi: entryPointAbi, functionName: 'handleOps', args: [[packed], relayer.address], account: relayer });
    } catch (e) {
      console.warn('owner op simulation failed:', (e as Error).message.split('\n')[0]);
      throw new UserError('That could not be completed. Please check your PIN and try again.');
    }
    const hash = await relay((w) => w.writeContract({ address: dep.entryPoint, abi: entryPointAbi, functionName: 'handleOps', args: [[packed], relayer.address], account: relayer, chain: w.chain }));
    const receipt = await waitForConfirmations(client, hash, 1n);
    const ok = receipt.logs.some((l) => l.address.toLowerCase() === dep.entryPoint.toLowerCase() && l.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f' && l.data.length >= 2 + 64 * 2 && BigInt('0x' + l.data.slice(2 + 64, 2 + 128)) === 1n);
    if (!ok) throw new UserError('The network rejected that action. Nothing changed.');

    // Orders signed with the previous trading key can no longer settle; cancel them so they never block a batch.
    if (policy.action === 'revokeSession' || policy.action === 'setSession') {
      db.cancelPending(tgId, 'Cancelled because your trading permission changed. Nothing was traded.');
    }
    // A successful setSession with the key we issued activates it for trading.
    if (policy.action === 'setSession') {
      const d = decodeFunctionData({ abi: QalibreAccountAbi, data: op.callData });
      const key = (d.args?.[0] as { key: Address }).key;
      db.activatePendingSession(tgId, key);
    }
    // A token approved from a chat card: update that card in the chat now, no Refresh needed.
    if (policy.approved?.length && hooks.onApproved) void Promise.resolve(hooks.onApproved(tgId, policy.approved)).catch((e) => console.error('after approval', (e as Error).message));
    return { tx: hash, action: policy.action };
  }

  /** A fresh trading key for "turn trading back on". Its private half never leaves the server encrypted. */
  function newSessionKey(tgId: number) {
    accountOf(tgId);
    const pk = generatePrivateKey();
    const key = privateKeyToAccount(pk).address;
    db.setPendingSession(tgId, key, encrypt(pk, config.sessionEncKey, `user:${tgId}`));
    return { key };
  }

  return { prepare, send, newSessionKey };
}

export type OwnerOps = ReturnType<typeof createOwnerOps>;
export { isAddress, pad, numberToHex };
