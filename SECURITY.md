# Security policy

Qalibre handles wallets and trades, so we take reports seriously and answer every one.

## Reporting a vulnerability

Email **security@qalibre.app**, or open a [private security advisory](https://github.com/qalibrehq/qalibre/security/advisories/new). Please include the steps to reproduce, the affected contract or component, and the impact you expect.

Do not open a public issue, and give us reasonable time to fix the problem before you disclose it.

## Scope

- Contracts in [`contracts/`](contracts), deployed on QMS testnet (addresses in the [README](README.md#deployments))
- The batch engine in [`solver/`](solver)
- The bot, API and token checks in [`backend/`](backend)
- The Mini App in [`miniapp/`](miniapp)

Known limitations are listed on [qalibre.app/security](https://qalibre.app/security#limits) and do not need to be reported again.

## Status

Qalibre runs on testnet and test tokens have no value. An independent audit will be completed and published before mainnet.
