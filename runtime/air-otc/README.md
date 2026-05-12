# AIR OTC Runtime

`air-otc` is the no-code runtime for AIR OTC.

It is the supported path for users who want to run an AIR OTC agent **without editing source code**.

## What it does

The runtime wraps the public TypeScript SDK and gives non-technical operators:

- an interactive setup wizard
- config-file driven startup
- a validator for wallet and backend config
- prebuilt runtime roles
- a one-command paired proof path

## Roles

The runtime currently supports:

- `buyer`
- `seller`
- `watcher`
- `maker`

## CLI contract

```bash
air-otc init
air-otc validate
air-otc start
air-otc start --role buyer
air-otc start --role seller
air-otc proof pair
```

The default config file is:

- `agentotc.config.yaml`

An example config lives at:

- [agentotc.config.example.yaml](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/agentotc.config.example.yaml)

## Install and build

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm install
npm run build
```

## Interactive setup

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run init
```

The wizard prompts for:

- API URL
- WebSocket URL
- RPC URL
- environment
- wallet private key
- role
- mode
- strategy parameters
- PER terms and delivery content when needed

## Validate a config

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run validate
```

This checks:

- required connection fields
- wallet presence
- role and mode
- required seller offer config
- required PER delivery/private-term fields
- backend health

## Start the runtime

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run start
```

Or explicitly:

```bash
npm run start:buyer
npm run start:seller
```

## One-command pair proof

The runtime also exposes the paired proof entry:

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run proof:pair
```

This is the no-code wrapper around the flagship buyer/seller proof path.

The current proof entry expects buyer and seller proof keys from environment variables:

- `AIR_OTC_PROOF_BUYER_KEY`
- `AIR_OTC_PROOF_SELLER_KEY`

Optional overrides:

- `AIR_OTC_API_URL`
- `AIR_OTC_WS_URL`
- `AIR_OTC_RPC_URL`
- `AIR_OTC_PROOF_ASSET`
- `AIR_OTC_PROOF_ASSET_MINT`
- `AIR_OTC_PROOF_AMOUNT`
- `AIR_OTC_PROOF_PRICE`
- `AIR_OTC_PROOF_COLLATERAL`
- `AIR_OTC_PROOF_DELIVERY`

## Latest live verification

The latest workspace verification for the runtime proof path completed successfully on 2026-05-10 with:

- ticket: `e2023f32-3b36-45be-b27b-d7ced1352317`
- offer: `9be62187-a6b8-4e02-bb98-192f4582b741`
- escrow PDA: `5iPqVz7e5Swce6XS29Ar1uhRcN69YpZHrtExEJNcC9M`
- middleman `DealPhaseState.phase`: `settled`
- audit status: valid
- audit event count: `37`
- timeline events: `52`
- shielded-credit audit event: `confidential_shielded_credit_settled`

That proof used the same `proof pair` entrypoint shipped by this package, with `AIR_OTC_PROOF_BUYER_KEY` and `AIR_OTC_PROOF_SELLER_KEY` mapped from the configured devnet proof wallets. The proof reached settled state; the Node wrapper was manually stopped after success because websocket handles stayed open.

## Verification

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run typecheck
npm run build
```

## Related docs

- [sdk/README.md](/Users/tutul/Downloads/AIR OTC/sdk/README.md)
- [sdk/ts/README.md](/Users/tutul/Downloads/AIR OTC/sdk/ts/README.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
