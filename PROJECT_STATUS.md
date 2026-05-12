# AIR OTC Project Status

Last updated: 2026-05-10

This file is the canonical status snapshot for AIR OTC. It is meant to match the code, exported interfaces, proof scripts, and verified commands in this repository.

## Current product shape

AIR OTC is currently organized into four public-facing layers:

1. Technical integrations
   - TypeScript SDK at [/Users/tutul/Downloads/AIR OTC/sdk/ts](</Users/tutul/Downloads/AIR OTC/sdk/ts>)
   - Python SDK at [/Users/tutul/Downloads/AIR OTC/sdk/python](</Users/tutul/Downloads/AIR OTC/sdk/python>)

2. No-code runtime
   - Config-driven CLI runtime at [/Users/tutul/Downloads/AIR OTC/runtime/air-otc](</Users/tutul/Downloads/AIR OTC/runtime/air-otc>)

3. Human observatory
   - Read-only Next.js frontend at [/Users/tutul/Downloads/AIR OTC/frontend](</Users/tutul/Downloads/AIR OTC/frontend>)

4. External agent/operator MCP
   - Local stdio and HTTP MCP server at [/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server](</Users/tutul/Downloads/AIR OTC/mcp/air-otc-server>)

## What is implemented

### SDK

- The TypeScript SDK exposes the low-level client surface:
  - `offers`
  - `agents`
  - `deals`
  - `dm`
- The TypeScript SDK also exposes an explicit workflow layer:
  - `client.workflows.quickBuyEr(...)`
  - `client.workflows.quickSellEr(...)`
  - `client.workflows.quickBuyPer(...)`
  - `client.workflows.quickSellPer(...)`
  - `client.workflows.runBuyerFlow(...)`
  - `client.workflows.runSellerFlow(...)`
- The SDK package now includes a judge-facing PER workflow proof script:
  - `npm --prefix "/Users/tutul/Downloads/AIR OTC/sdk/ts" run proof:per:sdk`
  - this proves the app-facing flow can be expressed through the public workflow API; the API server and middleman runtime still remain required infrastructure.
- The Python SDK exposes:
  - low-level agent, offer, and deal surfaces
  - ER workflow helpers
  - PER protocol models and hash/serialization helpers
  - `LivePerClient`
  - `quick_buy_per`, `quick_sell_per`, `run_buyer_flow(mode="PER")`, and `run_seller_flow(mode="PER")`
  - shielded-credit funding and signed release approval support
  - a fail-closed boundary where Python must receive supplied encrypted terms or a prebuilt PER handoff bundle instead of inventing FHE ciphertext locally

### No-code runtime

- The Node runtime supports:
  - `air-otc init`
  - `air-otc validate`
  - `air-otc start`
  - `air-otc start --role buyer|seller|watcher|maker`
  - `air-otc proof pair`
- The runtime is config-driven via `agentotc.config.yaml`
- An example config lives at [agentotc.config.example.yaml](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/agentotc.config.example.yaml)

### External agents

- Real ElizaOS buyer/seller agents live at [/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent](</Users/tutul/Downloads/AIR OTC/agents/elizaos-agent>)
- They use the public TypeScript SDK rather than internal middleman code
- The flagship external-agent proof path is PER with encrypted DM delivery and post-settlement Torque delivery
- `npm run proof:per` remains the two-agent ElizaOS proof.
- `npm run proof:per:sdk` runs the public SDK workflow proof from the same workspace.

### MCP

- AIR OTC now includes a scoped MCP server for external AI agents and operators.
- The MCP server supports stdio by default and HTTP with `--http`.
- Implemented tools:
  - `airotc_list_offers`
  - `airotc_create_offer`
  - `airotc_accept_offer`
  - `airotc_run_per_buyer_flow`
  - `airotc_run_per_seller_flow`
  - `airotc_get_deal_status`
  - `airotc_get_proof_bundle`
  - `airotc_vault_status`
  - `airotc_umbra_lifecycle_status`
  - `airotc_health`
- Mutating tools are scope-gated and the server does not return private keys, plaintext PER terms, or sealed metadata.

### Observatory frontend

The frontend is intentionally observatory-only. Its route contract is:

- `/` → Dashboard
- `/explorer` → Deal explorer
- `/marketplace` → Live offer board
- `/agents` → Agent directory
- `/docs` → Quickstart / integration docs

There is no telemetry-first primary route in the canonical product contract.

## Recent hardening since the prior proof pass

- `MeridianClient` now treats an already-authenticated websocket session as healthy and ignores stale socket close/error events, which prevents self-replacement reconnect storms in the live SDK/runtime path.
- PER permission delegation now fails fast into `session_only_fallback` when the known upstream permission borrow conflict occurs, instead of burning retries and timing out the trade.
- The close-permission cleanup path now signs with the correct signer set for permission-only close transactions.
- Strict PER now defaults to `SHIELDED_CREDIT`; `DIRECT_SOL` is rejected unless `PER_ALLOW_DIRECT_SOL_UNSAFE=true`.
- The confidential escrow program now has a vault-backed internal credit rail with deposit, lock, settle, queued withdrawal, batch withdrawal, and timeout-refund instructions.
- `CONFIDENTIAL_FUNDING_REQUEST` is versioned and carries shielded-credit rail metadata and credit-lock commitments.
- The middleman verifies shielded-credit lock evidence for strict PER instead of accepting direct per-deal SOL deposit evidence.
- Full-Umbra mode now emits `UMBRA_LIFECYCLE_REQUEST` and only marks completion from real ordered shield / UTXO / claim / unshield evidence; `sdk_fallback_tx` is rejected.
- The ElizaOS full-pipeline proof gate now rejects false success unless both agents submit shielded-credit funding, the seller sends encrypted delivery, the buyer receives it and signs release confirmation, and both parties complete full Umbra lifecycle evidence.
- TypeScript SDK and ElizaOS now have automatic full-Umbra lifecycle execution helpers for shield, receiver UTXO creation, claim, and unshield.
- Production Umbra lifecycle evidence is RPC-verified against the expected Umbra program unless explicitly disabled for tests.
- Umbra indexer and relayer endpoints are now resolved by network; devnet uses the official devnet endpoints and fails fast if configured with official mainnet endpoints.
- The local Zerion CLI fork now includes AIR OTC policy, live online-check, buyer/seller verification, real transaction evidence, and proof-bundle commands used by the full-pipeline proofs. Devnet proofs default to `AIROTC_ZERION_ONLINE_CHECK_MODE=light`; strict wallet portfolio checks are available with `AIROTC_ZERION_VERIFY_TRADE_WALLETS=true`.

These changes live primarily in:

- [/Users/tutul/Downloads/AIR OTC/middleman-agent/agents/sdk/MeridianClient.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/agents/sdk/MeridianClient.ts>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/privateNegotiationService.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/privateNegotiationService.ts>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/negotiationRollupService.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/negotiationRollupService.ts>)
- [/Users/tutul/Downloads/AIR OTC/escrow/programs/escrow-confidential/src/lib.rs](</Users/tutul/Downloads/AIR OTC/escrow/programs/escrow-confidential/src/lib.rs>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/confidentialFundingService.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/confidentialFundingService.ts>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/umbraService.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/umbraService.ts>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/stealthSettlementService.ts](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/stealthSettlementService.ts>)
- [/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/proof/fullPipelineProof.ts](</Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/proof/fullPipelineProof.ts>)
- [/Users/tutul/Downloads/AIR OTC/middleman-agent/zerion-core/cli/commands/airotc.js](</Users/tutul/Downloads/AIR OTC/middleman-agent/zerion-core/cli/commands/airotc.js>)

## Verified commands

These commands were validated during the current implementation pass.

### Frontend

```bash
cd "/Users/tutul/Downloads/AIR OTC/frontend"
npm run build
```

Passes with the webpack build path.

### TypeScript SDK

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run build
npm run test
```

Both pass.

### Python SDK

```bash
cd "/Users/tutul/Downloads/AIR OTC"
sdk/python/venv/bin/python -m compileall sdk/python/agentotc/src/agentotc
PYTHONPATH=sdk/python/agentotc/src sdk/python/venv/bin/python sdk/python/test_per_vectors.py
```

Both pass.

### Escrow confidential program

```bash
cd "/Users/tutul/Downloads/AIR OTC/escrow"
cargo check -p escrow-confidential
cargo test -p escrow-confidential
anchor build -p escrow-confidential
```

All pass. The regenerated confidential escrow IDL includes the shielded-credit instructions.

The shielded-credit confidential escrow program is deployed on devnet as:

- program id: `BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj`
- deploy signature: `46iC8NNsUWrTPeHqtJuKjHuhAE2bXGqhAeDPiuP5yxqwM9MG29sSvKwC7A9r4et5Wj3EPP3QBXSta336maPwiCfT`
- last verified with:

```bash
solana program show BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj --url devnet
```

### MCP server

```bash
cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm run typecheck
npm run build
npm test
npm audit --audit-level=moderate
```

All pass; `npm audit` reports `0` vulnerabilities.

### API server

```bash
cd "/Users/tutul/Downloads/AIR OTC/api-server"
npm run typecheck
npx vitest run tests/encrypt_status_proxy.test.ts tests/internal_surfaces_security.test.ts tests/internal_bridge_auth.test.ts tests/per_marketplace_bridge.test.ts tests/per_ticket_redaction.test.ts tests/per_marketplace_offer_flow.test.ts
```

Passes with `6` files and `21` tests.

### No-code runtime

```bash
cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run typecheck
npm run build
```

Both pass.

### Middleman runtime safety gate

```bash
cd "/Users/tutul/Downloads/AIR OTC/middleman-agent"
npm run typecheck
npx vitest run tests/per_permission_activation_fallback.test.ts tests/negotiation_rollup_service_fallback.test.ts tests/meridian_client_reconnect_durability.test.ts tests/observatory_bridge_auth.test.ts
npm run test:pipeline:critical
npm run test:component:e2e
npm test
```

Passes. The full middleman test run currently reports `258` passed tests and `1` intentionally skipped Dune SIM E2E gate.

## Latest live proofs in this workspace

### Latest TypeScript SDK PER shielded-credit proof

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
set -a; source ../../middleman-agent/.env; set +a
npm run proof:per:sdk
```

The latest workspace verification completed successfully on 2026-05-10 with the redeployed shielded-credit program:

- ticket: `876bef08-88fc-4c19-880c-974a06e43916`
- offer: `30a54cca-2873-473b-aaf0-c2ce90f41991`
- escrow PDA: `6HWLEAfZ45bXrfkT2gMQMYzFdDPT3u7hEk3bC1tGdGdA`
- middleman phase: `settled`
- audit status: valid
- audit event count: `37`
- timeline events: `52`
- shielded-credit audit event: `confidential_shielded_credit_settled`
- MCP proof-bundle smoke for the same ticket returned `deal_status`, `audit`, and `timeline` data with `auditValid=true`
- note: the proof reached settled state; the Node wrapper was manually stopped after success because websocket handles stayed open

### Latest external-agent Eliza PER proof

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
npm run proof:per
```

The latest ElizaOS buyer/seller proof completed successfully on 2026-05-10 with:

- ticket: `5826ad0a-04df-4d29-b5f8-d30563bf0752`
- offer: `5f343603-271b-40c9-9dda-e3bd32189ec3`
- escrow PDA: `EgPjYbHNYAvqu5A93e7WYEWzx2Aa1uXLVkSEA6qvpb3C`
- output: `[ELIZA-PROOF] buyer and seller external Eliza agents completed the PER flagship flow`
- middleman phase: `settled`
- audit status: valid
- audit event count: `41`
- timeline events: `57`
- shielded-credit audit event: `confidential_shielded_credit_settled`
- note: the proof settled; an extra seller Umbra lifecycle retry continued after settlement and was stopped without changing the settled proof status

### Latest full-diagram soak proof

```bash
cd "/Users/tutul/Downloads/AIR OTC/middleman-agent"
npm run test:diagram:soak
```

The latest fresh Day 2 diagram-soak smoke rerun completed on 2026-05-10 with:

- command: `DIAGRAM_SOAK_RUNS=1 npm run test:diagram:soak`
- total runs: `2`
- passed: `2`
- failed: `0`
- PER buyer-only approval gate: `1/1`
- full ER+PER happy path: `1/1`
- bundle-safe summary: [/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json)

The historical full default soak completed on 2026-05-06 with:

- total runs: `10`
- passed: `10`
- failed: `0`
- PER buyer-only approval gate: `5/5`
- full ER+PER happy path: `5/5`
- bundle-safe summary: [/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json)

The 2026-05-10 default long soak was attempted and reached `4/5` live scenario passes before external devnet dependencies interrupted completion. Do not present that interrupted long run as green; use the fresh 2026-05-10 `2/2` smoke and the historical 2026-05-06 `10/10` full soak as the judge-facing evidence.

### Latest local full-pipeline Umbra gates

```bash
cd "/Users/tutul/Downloads/AIR OTC/middleman-agent"
npm run test:full-pipeline:local:e2e
npm run test:full-pipeline:soak
```

The latest local verification completed with:

- full-Umbra lifecycle local E2E: `3` files, `10` tests passed after strict full-Umbra default and endpoint guard hardening
- full-Umbra lifecycle soak: `20` sequential settlements, no stuck states, no duplicate evidence
- Umbra endpoint policy/preflight coverage is present for network-aware devnet/mainnet endpoint guards
- Zerion AIR OTC CLI suite: passed inside `middleman-agent/zerion-core`
- TypeScript SDK build: passed after adding full-Umbra workflow gating
- ElizaOS typecheck: passed after adding full-pipeline action gating
- Live Eliza full-pipeline proof: ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c`, offer `5024c326-3b75-4d7f-9aba-75c4aad05adb`, completed online Zerion CLI/API gate plus strict PER, shielded-credit funding, encrypted delivery, buyer release confirmation, shielded-credit settlement, full Umbra shield / UTXO / claim / unshield, and post-Umbra Torque sidecar delivery on devnet.
  - command: `AIROTC_TRADE_PRICE_SOL=0.001 AIROTC_TRADE_COLLATERAL_SOL=0.0001 AIROTC_TRADE_AMOUNT=1 AIROTC_REQUIRE_FULL_UMBRA=true UMBRA_SETTLEMENT_LIFECYCLE_MODE=FULL_UMBRA AIROTC_REQUIRE_ZERION=true AIROTC_ZERION_ONLINE_CHECK_MODE=light AGENT_LOOP_DELAY_MS=2500 AGENT_MAX_LOOPS=360 npm run proof:full-pipeline`
  - Zerion online snapshot hash: `4b7726760eb4356345de5e51c3066ee6538b9fc0882c2281078bbcc8d3774969`
  - escrow PDA: `5PrqGPyMspsPehK2h1PVpo3Fd4R2Pdo4TyAdqhmi7h9K`
  - audit: valid with `45` entries
  - timeline events: `62`
  - audit events: `confidential_shielded_credit_settled`, `deal_pipeline_settled_confirmed`, `deal_pipeline_umbra_lifecycle_completed_confirmed`
  - Umbra state: `PrivateSettlement.lifecycleMode=FULL_UMBRA`, settlement phase `COMPLETED`
  - release tx: `4UZWGTGWXb6uiyjfS3sk9pJtxNn1cCdxAnDhjAxhRonxwQrd9aCgrLUTEY9FEmPkabS1b7eQQ5K6U9TJbe3xAZrJ`
  - approval tx: `2XpFSUacn2odVAZ8xy5pncei8bARX8PoFBsqw9zH2JzD5QkafzP7iBYTSWmfsgFGFwZSN8qCJiVgkjZwhaZwB6Ye`
  - Umbra lifecycle completed hash: `a578dd4568d1065c5cb66e8471d1b13604a3648e414a026dba8d70bd0a722f15`
  - Torque sidecar: buyer and seller `TorqueEventDelivery.status=sent`
  - MCP verification on 2026-05-10: `airotc_get_deal_status`, `airotc_umbra_lifecycle_status`, and `airotc_get_proof_bundle` confirmed completed status, Umbra lifecycle completion, and proof-bundle data
  - real Zerion transaction evidence still requires `AIROTC_ZERION_EXTERNAL_TX` or `AIROTC_ZERION_EXECUTE_REAL_TX=true`

The live full-pipeline commands require real configured external services, Zerion evidence, and Umbra-capable wallets:

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
npm run proof:full-pipeline
npm run proof:full-pipeline:soak

cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run proof:full-pipeline:sdk
```

### Latest no-code runtime PER pair proof

The latest no-code runtime PER proof completed successfully on 2026-05-10:

- ticket: `e2023f32-3b36-45be-b27b-d7ced1352317`
- offer: `9be62187-a6b8-4e02-bb98-192f4582b741`
- escrow PDA: `5iPqVz7e5Swce6XS29Ar1uhRcN69YpZHrtExEJNcC9M`
- middleman phase: `settled`
- audit status: valid
- audit event count: `37`
- timeline events: `52`
- shielded-credit audit event: `confidential_shielded_credit_settled`
- command used the same `npm run proof:pair` entrypoint with `AIR_OTC_PROOF_BUYER_KEY` and `AIR_OTC_PROOF_SELLER_KEY` mapped from the devnet proof wallets
- note: the proof reached settled state; the Node wrapper was manually stopped after success because websocket handles stayed open

### Attempted SDK-only full-pipeline proof

The SDK-only full-pipeline command was attempted on 2026-05-10:

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
set -a; source ../../middleman-agent/.env; set +a
AIROTC_TRADE_PRICE_SOL=0.001 AIROTC_TRADE_COLLATERAL_SOL=0.0001 AIROTC_TRADE_AMOUNT=1 AIROTC_REQUIRE_FULL_UMBRA=true UMBRA_SETTLEMENT_LIFECYCLE_MODE=FULL_UMBRA AIROTC_REQUIRE_ZERION=true npm run proof:full-pipeline:sdk
```

The command failed closed before opening a deal because real Zerion transaction evidence was not supplied: `AIROTC_ZERION_EXTERNAL_TX` or `AIROTC_ZERION_EXECUTE_REAL_TX=true` is required. This remains an honest boundary, not a claimed live pass.

## Current honest boundaries

These remain important and should not be overclaimed away in demos or docs:

1. Python PER is implemented as a fail-closed parity surface, not yet an independent FHE producer
   - Python has PER models, hashes, funding, release approval, lifecycle evidence, and workflow helpers
   - Python can complete PER when supplied with encrypted terms or a prebuilt handoff bundle
   - Python-side Encrypt gRPC ciphertext creation is still not proven as a standalone live path

2. AIR OTC is trust-minimized and privacy-hardened, not fully trustless
   - native SOL entry and exit remain public on Solana
   - the shielded-credit rail detaches strict PER deal funding from direct per-ticket SOL deposits and is now live-proven for TypeScript SDK, ElizaOS, no-code runtime, and soak paths on devnet
   - MagicBlock, Encrypt, Umbra, IKA, Zerion, RPC providers, and the middleman runtime remain trust or availability dependencies
   - full Umbra shield / UTXO / claim / unshield completion requires real signed `UMBRA_SETTLEMENT_SUBMITTED` evidence and cannot be marked complete from placeholder signatures

3. Full automatic Umbra shield / UTXO / claim / unshield is implemented and live-recorded for the ElizaOS TypeScript path; SDK-only full-pipeline was attempted on 2026-05-10 and failed closed until real or external Zerion transaction evidence is supplied
   - live Eliza full-pipeline ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c` reached `PrivateSettlement` lifecycle completion
   - buyer and seller both have real shield, UTXO, claim, and unshield lifecycle evidence in the database
   - the same live ticket also includes encrypted seller delivery and signed buyer release confirmation before final proof success
   - the backend rejects fallback evidence and only accepts ordered real transaction evidence for full lifecycle completion
   - production mode verifies submitted txs against the expected Umbra program
   - local full-pipeline E2E and soak gates pass

4. Mixed Python/TypeScript live PER is not yet independently live-proven
   - Python PER models, golden vectors, funding helpers, release approval, and lifecycle evidence paths pass local verification
   - Python-side Encrypt gRPC ciphertext creation remains the explicit fail-closed boundary

5. The frontend is not the execution surface for agents
   - agents trade through the SDK or runtime
   - humans observe through the frontend

## What judges and contributors should read first

1. [SUBMISSION_README.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_README.md)
2. [NEW_SUBMISSION_CHECKLIST.md](/Users/tutul/Downloads/AIR OTC/NEW_SUBMISSION_CHECKLIST.md)
3. [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
4. [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
5. [sdk/README.md](/Users/tutul/Downloads/AIR OTC/sdk/README.md)
6. [frontend/README.md](/Users/tutul/Downloads/AIR OTC/frontend/README.md)
7. [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
8. [docs/HOW_TO_VERIFY.md](/Users/tutul/Downloads/AIR OTC/docs/HOW_TO_VERIFY.md)
9. [docs/JUDGE_DEMO_SCRIPT.md](/Users/tutul/Downloads/AIR OTC/docs/JUDGE_DEMO_SCRIPT.md)

## What should be treated as historical or supporting only

- [GRANT_APPLICATION_DRAFT.md](/Users/tutul/Downloads/AIR OTC/GRANT_APPLICATION_DRAFT.md)
- [middleman-agent/SUBMISSION_GUIDE.md](/Users/tutul/Downloads/AIR OTC/middleman-agent/SUBMISSION_GUIDE.md)
- legacy mirror files under [/Users/tutul/Downloads/AIR OTC/docs](</Users/tutul/Downloads/AIR OTC/docs>) other than [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
