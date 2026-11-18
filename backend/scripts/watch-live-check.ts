/** One live reading and full check of a token, as the watcher does it.  npx tsx scripts/watch-live-check.ts <token> */
import { erc20Abi, type Address } from 'viem';
import { checkToken, poolOf, tokenInfo } from '../src/tokens.js';
import { publicClient } from '../../solver/src/chain.js';
const t = process.argv[2] as Address;
const chain = publicClient();
let t0 = Date.now();
const info = await tokenInfo(t);
const [pool, supply] = await Promise.all([poolOf(info), chain.readContract({ address: t, abi: erc20Abi, functionName: 'totalSupply' })]);
console.log(`${info.symbol}: pool ${Number(pool.qmsReserve) / 1e18} QMS, supply ${Number(supply) / 10 ** info.decimals}, reading took ${Date.now() - t0}ms`);
t0 = Date.now();
const s = await checkToken(t, { fresh: true });
console.log(`full check: ${s.verdict}${s.reason ? ` (${s.reason})` : ''}, took ${Date.now() - t0}ms`);
