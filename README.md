<p align="center"><img src="brand/qalibre-wordmark-ink.svg" width="220" alt="qalibre" /></p>

<h3 align="center">Every trade, protected.</h3>

<p align="center">Trading on QMS from Telegram. Every token is checked before you buy, every trade gets the best price available, and your keys never leave your phone.</p>

<p align="center"><a href="https://t.me/QalibreBot">Open in Telegram</a> · <a href="https://qalibrehq.github.io/qalibre/">Website</a> · <a href="docs/AUDIT.md">Audit</a> · <a href="#contracts">Contracts</a></p>

---

**Live on QMS testnet.** Test tokens only; nothing here has real value.

## What it does

| | |
|---|---|
| **Scams stopped before you buy** | Paste a token and Qalibre test-trades it on the live chain, spending nothing: a simulated buy and sale through an injected probe contract. Honeypots and hidden taxes are blocked outright. Creator powers (mint, pause, blacklist, upgradeable proxy) are found in the bytecode and explained in plain words. The check runs again at the moment of every buy. |
| **The best price, enforced on-chain** | Orders are gathered into short batches. Buyers and sellers in the same batch trade with each other at one uniform price; only the remainder is routed to an exchange pool. Before anything settles, the settlement contract asks the exchange what a direct swap would pay and refuses any fill below it. |
| **Self-custody, with limits** | Each user has an ERC-4337 smart account owned by a key created on their device and encrypted with their PIN. Qalibre holds a narrow session key: it can only settle orders into the user's own account, for tokens they approved, within per-trade and daily limits enforced by the contract. It cannot withdraw. |
| **Built on QMS** | Choosing which orders clear together is posed as a QUBO, the optimization class QMS useful-work miners solve. Every batch's QUBO is exported in Matrix Market format so the selection can be verified. Today it is solved by simulated annealing and checked against an exact solver. |

## How it fits together

```
Telegram chat ─┐                       ┌─ Settlement contract ── price floor vs a direct swap
               ├─ backend (bot, API, ──┤    ├─ user smart accounts (session keys, limits)
Mini App ──────┘  safety engine)       │    └─ venue adapters (exchange pools)
                                       └─ solver: batch → QUBO → uniform price → settle
```

| Folder | What is in it |
|---|---|
| [`contracts/`](contracts) | Solidity (Foundry): settlement, smart account and factory, paymaster, venue adapter, safety probe. 58 tests, including invariants against a compromised backend. |
| [`solver/`](solver) | Batch clearing: uniform-price matching, QUBO build and solve, settlement submission with reorg handling. |
| [`backend/`](backend) | Telegram bot, Mini App API, safety engine, owner actions (ERC-4337, sponsored), share cards. |
| [`miniapp/`](miniapp) | The Telegram Mini App (React): wallet, trading, approvals, limits, activity. |
| [`site/`](site) | The website. |
| [`docs/`](docs) | [Audit](docs/AUDIT.md) (including what is still open), [chat trading pre-mortem](docs/CHAT_TRADING.md), [expansion plan](docs/EXPANSION.md). |

## Contracts

All verified on the [QMS testnet explorer](https://testnet.qmsscan.io) (chain 19480).

| Contract | Address |
|---|---|
| Settlement | [`0x88126dec9c886AEE446F1eB7c15524e6BCbb19F4`](https://testnet.qmsscan.io/address/0x88126dec9c886AEE446F1eB7c15524e6BCbb19F4) |
| Account factory | [`0xC443B86882C67f42EafC136591964FfC82997154`](https://testnet.qmsscan.io/address/0xC443B86882C67f42EafC136591964FfC82997154) |
| Account implementation | [`0xa82F72A2Ab8ceAD6aa285bE5A5370e3ea6F53E20`](https://testnet.qmsscan.io/address/0xa82F72A2Ab8ceAD6aa285bE5A5370e3ea6F53E20) |
| Exchange adapter | [`0xDfAf7FA80a5f31190d2Ea5A76a4F90b3d119b414`](https://testnet.qmsscan.io/address/0xDfAf7FA80a5f31190d2Ea5A76a4F90b3d119b414) |
| Paymaster | [`0xd8f6886D35B541891F96ea79e45e4BbD87050f8C`](https://testnet.qmsscan.io/address/0xd8f6886D35B541891F96ea79e45e4BbD87050f8C) |

Governance: adding a venue or raising a fee is delayed 48 hours and public on-chain; removals and fee cuts apply at once.

## Fees

Qalibre takes 20% of what it saves you versus a direct swap, never more than 0.2% of the trade. No saving, no fee. Exchange fees apply only to the part routed to a pool. Network costs are passed through at cost, capped by a maximum the user signs.

## Run it

```bash
# contracts
cd contracts && forge test
# solver and backend
cd solver && npm ci && npm test
cd backend && npm ci && npm test
# everything in one container (secrets via environment only)
docker build -t qalibre . && docker run --env-file qalibre.env -v qalibre-data:/data -p 8787:8787 qalibre
```

## Security

Found a vulnerability? Please report it privately through a [GitHub security advisory](https://github.com/qalibrehq/qalibre/security/advisories/new), not a public issue. An external audit comes before mainnet.

## Status

Testnet. Not financial advice. A safety check reduces risk; it cannot guarantee a token is safe.
