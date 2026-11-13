<p align="center"><img src="brand/qalibre-wordmark-ink.svg" width="200" alt="Qalibre" /></p>

<p align="center"><b>Every trade, protected.</b></p>

<p align="center">
  <a href="https://qalibrehq.github.io/qalibre/">Website</a> ·
  <a href="https://t.me/QalibreBot">Telegram</a> ·
  <a href="https://qalibrehq.github.io/qalibre/security.html">Security</a> ·
  <a href="docs/AUDIT.md">Audit</a>
</p>

Qalibre is a trading app for the QMS network that lives inside Telegram. Every token is test-traded before you can buy it, every trade is settled at the best price available and never below a direct swap, and your wallet is a smart account that only you can withdraw from.

> Qalibre runs on QMS testnet. Test tokens have no value. Mainnet follows an independent security audit.

## How it works

**Checked before you buy.** When a token is pasted, Qalibre simulates a buy and a sale against live chain state using a probe contract injected into an `eth_call`, so nothing is spent. Honeypots and hidden transfer taxes are refused. The bytecode is scanned for creator powers such as minting, pausing, blacklists and upgradeable proxies. The check runs again at the moment of purchase.

**Settled at the best price.** Orders are collected into short batches. Buyers and sellers in the same batch are matched at a single uniform price; only the remainder is routed to an exchange pool. The settlement contract quotes a direct swap for every order and reverts the batch if any fill would be worse.

**Held by you.** Each user has an ERC-4337 smart account owned by a key generated on their device and encrypted with their PIN. Qalibre trades through a separate session key that can only settle orders into the user's own account, for tokens the user approved, within per-trade and daily limits enforced on-chain. It has no withdrawal rights and can be revoked at any time.

**Native to QMS.** Selecting which orders clear together is formulated as a QUBO, the optimization class solved by QMS useful-work miners. Each batch's QUBO is exported in Matrix Market format so the selection can be reproduced. It is currently solved by simulated annealing and cross-checked against an exact solver.

## Architecture

```
 Telegram chat ─┐                          ┌─ QalibreSettlement ── direct-swap price floor
                ├── backend ── solver ─────┤     ├─ QalibreAccount (per user, ERC-4337)
 Mini App ──────┘   bot · API · safety     │     └─ venue adapters ── exchange pools
                                           └─ QalibrePaymaster (sponsors owner actions)
```

| Path | Contents |
|---|---|
| [`contracts/`](contracts) | Solidity, built with Foundry: settlement, smart account and factory, paymaster, venue adapter, safety probe. |
| [`solver/`](solver) | Batch clearing: uniform-price matching, QUBO construction and solving, settlement submission with reorganization handling. |
| [`backend/`](backend) | Telegram bot, Mini App API, token safety engine, sponsored owner actions, share cards. |
| [`miniapp/`](miniapp) | Telegram Mini App (React): wallet, trading, token approvals, limits, activity. |
| [`site/`](site) | Website, published to GitHub Pages. |
| [`docs/`](docs) | [Security audit and open items](docs/AUDIT.md), [chat trading design](docs/CHAT_TRADING.md), [expansion plan](docs/EXPANSION.md). |

## Deployments

QMS testnet, chain ID 19480. All contracts are verified on the [explorer](https://testnet.qmsscan.io).

| Contract | Address |
|---|---|
| Settlement | [`0x88126dec9c886AEE446F1eB7c15524e6BCbb19F4`](https://testnet.qmsscan.io/address/0x88126dec9c886AEE446F1eB7c15524e6BCbb19F4) |
| Account factory | [`0xC443B86882C67f42EafC136591964FfC82997154`](https://testnet.qmsscan.io/address/0xC443B86882C67f42EafC136591964FfC82997154) |
| Account implementation | [`0xa82F72A2Ab8ceAD6aa285bE5A5370e3ea6F53E20`](https://testnet.qmsscan.io/address/0xa82F72A2Ab8ceAD6aa285bE5A5370e3ea6F53E20) |
| Exchange adapter | [`0xDfAf7FA80a5f31190d2Ea5A76a4F90b3d119b414`](https://testnet.qmsscan.io/address/0xDfAf7FA80a5f31190d2Ea5A76a4F90b3d119b414) |
| Paymaster | [`0xd8f6886D35B541891F96ea79e45e4BbD87050f8C`](https://testnet.qmsscan.io/address/0xd8f6886D35B541891F96ea79e45e4BbD87050f8C) |

Governance changes that could hurt users are slow and public: adding a venue or raising a fee takes effect only after a 48-hour delay. Removing a venue or lowering a fee is immediate.

## Fees

Qalibre charges 20% of the improvement it delivers over a direct swap, capped at 0.2% of the trade, and nothing when there is no improvement. Exchange fees apply only to the portion routed to a pool. Network costs are passed through at cost, never above a maximum the user signs with each order.

## Development

**Requirements:** Node.js 24, [Foundry](https://book.getfoundry.sh), and Docker for production builds.

```bash
# Contracts
cd contracts && forge install && forge test

# Solver and backend
cd solver && npm ci && npm test
cd backend && npm ci && npm test

# Mini App
cd miniapp && npm ci && npm run dev
```

**Configuration.** Secrets are read from the environment, or from `contracts/.env` during local development (see [`contracts/.env.example`](contracts/.env.example)). The backend additionally needs `TELEGRAM_BOT_TOKEN`, `SESSION_ENC_KEY`, and `MINIAPP_URL` for the public address of the Mini App. Never commit real keys.

**Production.** One container runs the bot, the API, the Mini App and the batch engine:

```bash
docker build -t qalibre .
docker run -d --restart unless-stopped --env-file qalibre.env -v qalibre-data:/data -p 8787:8787 qalibre
```

## Security

Please report vulnerabilities privately through a [security advisory](https://github.com/qalibrehq/qalibre/security/advisories/new) rather than a public issue. The current audit status, including known open items, is kept in [`docs/AUDIT.md`](docs/AUDIT.md).

Qalibre's safety checks reduce risk but cannot guarantee that a token is safe. Nothing in this repository is financial advice.

## License

© 2026 Qalibre. All rights reserved. A license for the source code will be published before mainnet.
