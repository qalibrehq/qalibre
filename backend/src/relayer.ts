/**
 * The relayer: the one server key that pays for wallet creation, owner actions and test funds.
 *
 * Every transaction it sends goes through one queue, one at a time, with nonces tracked locally. Without this,
 * two actions close together (a user approving a token while test funds go out) could read the same nonce
 * from the RPC and one would fail with "nonce too low". This happened live on QMS testnet on 2026-11-12. If the
 * node still reports a nonce conflict (for example a lagging RPC node), the local count is reset from the chain
 * and the send is retried once.
 */
import { BaseError, nonceManager, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { publicClient, walletClient } from '../../solver/src/chain.js';

export const relayer = privateKeyToAccount(config.relayerKey as Hex, { nonceManager });
const client = publicClient();
const wallet = walletClient(relayer);

let tail: Promise<unknown> = Promise.resolve();

function isNonceError(e: unknown): boolean {
  const text = e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ''} ${e.message}` : String(e);
  return /nonce (too low|too high|provided for the transaction is lower)|replacement transaction underpriced|already known/i.test(text);
}

/**
 * Send one transaction from the relayer, after every earlier one has been handed to the network.
 * `send` receives the wallet client and must return the transaction hash.
 */
export function relay(send: (w: typeof wallet) => Promise<Hex>): Promise<Hex> {
  const run = async () => {
    try {
      return await send(wallet);
    } catch (e) {
      if (!isNonceError(e)) throw e;
      // Re-read the nonce from the chain and try once more.
      nonceManager.reset({ address: relayer.address, chainId: client.chain!.id });
      return send(wallet);
    }
  };
  const result = tail.then(run, run);
  tail = result.catch(() => undefined);
  return result;
}
