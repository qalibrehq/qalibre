/**
 * Owner actions, signed on this device.
 *
 * The phone encodes the call itself, asks the server only for gas and sponsorship, then refuses to sign unless
 * the prepared operation is for this wallet and carries exactly the call the phone encoded. It computes the hash
 * itself; the server never supplies a hash to sign.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { PrivateKeyAccount } from 'viem/accounts';
import { tg } from './tg';

const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const QMS_TESTNET = 19480;

export const accountAbi = parseAbi([
  'function revokeSession()',
  'function setTokenLimit(address token, uint128 perTrade, uint128 perDay)',
  'function setAnyBuyToken(bool any)',
  'function setBuyTokenAllowed(address token, bool allowed)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] datas)',
  'function execute(address target, uint256 value, bytes data)',
  'struct TokenLimit { address token; uint128 perTrade; uint128 perDay; }',
  'struct SessionSetup { address key; uint48 validUntil; bool anyBuyToken; TokenLimit[] limits; address[] buyTokens; }',
  'function setSession(SessionSetup session)',
]);
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': tg?.initData ?? '' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? 'Something went wrong. Please try again.');
  return json as T;
}

function fromWire(w: Record<string, string>): UserOperation<'0.7'> {
  const big = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  const o: Record<string, unknown> = { ...w };
  for (const k of big) o[k] = BigInt(w[k]!);
  return o as unknown as UserOperation<'0.7'>;
}

/** Prepare, verify, sign on this device, submit. Returns the transaction hash. */
export async function runOwnerAction(owner: PrivateKeyAccount, wallet: string, callData: Hex): Promise<string> {
  const prep = await call<{ op: Record<string, string>; entryPoint: string; chainId: number }>('/api/owner/prepare', { callData });
  const op = fromWire(prep.op);
  // Refuse anything other than exactly what this device asked for, on this wallet, on QMS testnet.
  if (op.callData.toLowerCase() !== callData.toLowerCase()) throw new Error('Safety check failed: the action was changed. Nothing was signed.');
  if (op.sender.toLowerCase() !== wallet.toLowerCase()) throw new Error('Safety check failed: wrong wallet. Nothing was signed.');
  if (prep.entryPoint.toLowerCase() !== ENTRY_POINT_V07.toLowerCase() || prep.chainId !== QMS_TESTNET) throw new Error('Safety check failed: wrong network. Nothing was signed.');
  const hash = getUserOperationHash({ chainId: QMS_TESTNET, entryPointAddress: ENTRY_POINT_V07, entryPointVersion: '0.7', userOperation: op });
  const signature = await owner.signMessage({ message: { raw: hash } });
  const res = await call<{ tx: string }>('/api/owner/send', { op: { ...prep.op, signature } });
  return res.tx;
}

export const actions = {
  turnOff: () => encodeFunctionData({ abi: accountAbi, functionName: 'revokeSession' }),
  async turnOn(limits: { token: Address; perTrade: bigint; perDay: bigint }[]) {
    const { key } = await call<{ key: Address }>('/api/owner/session-key', {});
    return encodeFunctionData({
      abi: accountAbi,
      functionName: 'setSession',
      args: [{ key, validUntil: Math.floor(Date.now() / 1000) + 30 * 86400, anyBuyToken: false, limits, buyTokens: limits.map((l) => l.token) }],
    });
  },
  editLimits(wallet: Address, limits: { token: Address; perTrade: bigint; perDay: bigint }[]) {
    const datas = limits.map((l) => encodeFunctionData({ abi: accountAbi, functionName: 'setTokenLimit', args: [l.token, l.perTrade, l.perDay] }));
    return encodeFunctionData({ abi: accountAbi, functionName: 'executeBatch', args: [limits.map(() => wallet), limits.map(() => 0n), datas] });
  },
  /**
   * Chat-trading approval for one token, as one signed action: Qalibre may buy it, and may sell it back.
   * The sell limit is unbounded in token units because selling only ever returns QMS to this same wallet,
   * always at or above a direct swap's price; spending QMS stays capped by the QMS limits.
   */
  approveToken(wallet: Address, token: Address) {
    const MAX = 2n ** 128n - 1n;
    const datas = [
      encodeFunctionData({ abi: accountAbi, functionName: 'setBuyTokenAllowed', args: [token, true] }),
      encodeFunctionData({ abi: accountAbi, functionName: 'setTokenLimit', args: [token, MAX, MAX] }),
    ];
    return encodeFunctionData({ abi: accountAbi, functionName: 'executeBatch', args: [[wallet, wallet], [0n, 0n], datas] });
  },
  send(token: Address, to: Address, amount: bigint) {
    return encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [token, 0n, encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] })] });
  },
};
