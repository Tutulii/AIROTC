# AIR OTC Devnet Submission README

Last updated: 2026-05-10

## What AIR OTC is

AIR OTC is an agent-to-agent OTC settlement system for Solana. It gives autonomous agents and operators a way to post offers, accept private trades, deliver encrypted content, confirm release, and produce auditable devnet settlement evidence.

The product has four public surfaces:

- **TypeScript and Python SDKs** for technical builders
- **No-code runtime** for operators who want config-driven agents
- **Read-only observatory frontend** for human monitoring
- **MCP server** for external AI agents and operator tooling

The current flagship proof path is strict PER on devnet: online Zerion check, shielded-credit funding, encrypted seller delivery, buyer release confirmation, full Umbra shield / UTXO / claim / unshield lifecycle, and post-settlement Torque sidecar delivery.

## Current proof status

AIR OTC is **100% devnet submission-ready, not mainnet production-ready**.

Strongest current devnet proof:

- ticket: `13e6ae1d-68d0-46f0-a50a-6329965b598c`
- offer: `5024c326-3b75-4d7f-9aba-75c4aad05adb`
- escrow PDA: `5PrqGPyMspsPehK2h1PVpo3Fd4R2Pdo4TyAdqhmi7h9K`
- Zerion online snapshot hash: `4b7726760eb4356345de5e51c3066ee6538b9fc0882c2281078bbcc8d3774969`
- release tx: `4UZWGTGWXb6uiyjfS3sk9pJtxNn1cCdxAnDhjAxhRonxwQrd9aCgrLUTEY9FEmPkabS1b7eQQ5K6U9TJbe3xAZrJ`
- approval tx: `2XpFSUacn2odVAZ8xy5pncei8bARX8PoFBsqw9zH2JzD5QkafzP7iBYTSWmfsgFGFwZSN8qCJiVgkjZwhaZwB6Ye`
- audit: valid with `45` entries
- timeline: completed with `62` events
- required audit events: `confidential_shielded_credit_settled`, `deal_pipeline_settled_confirmed`, `deal_pipeline_umbra_lifecycle_completed_confirmed`
- Torque sidecar: buyer and seller delivery rows `sent`
- MCP verification: `airotc_get_deal_status`, `airotc_umbra_lifecycle_status`, and `airotc_get_proof_bundle` confirmed completed proof state on 2026-05-10

Supporting proof IDs:

- TypeScript SDK PER shielded-credit proof: `876bef08-88fc-4c19-880c-974a06e43916`
- ElizaOS PER shielded-credit proof: `5826ad0a-04df-4d29-b5f8-d30563bf0752`
- no-code runtime PER pair proof: `e2023f32-3b36-45be-b27b-d7ced1352317`

Sanitized proof summaries included in the submission bundle:

- [docs/proof-evidence/full-pipeline/2026-05-10-ticket-13e6ae1d-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/full-pipeline/2026-05-10-ticket-13e6ae1d-summary.json)
- [docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json)
- [docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json)

## How to verify locally

Run the local green gate:

```bash
cd "/Users/tutul/Downloads/AIR OTC/frontend"
npm run build

cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run build
npm run test

cd "/Users/tutul/Downloads/AIR OTC"
sdk/python/venv/bin/python -m compileall sdk/python/agentotc/src/agentotc
PYTHONPATH=sdk/python/agentotc/src sdk/python/venv/bin/python sdk/python/test_per_vectors.py

cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc"
npm run typecheck
npm run build

cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm run typecheck
npm run build
npm test
npm audit --audit-level=moderate

cd "/Users/tutul/Downloads/AIR OTC/api-server"
npm run typecheck
npx vitest run tests/encrypt_status_proxy.test.ts tests/internal_surfaces_security.test.ts tests/internal_bridge_auth.test.ts tests/per_marketplace_bridge.test.ts tests/per_ticket_redaction.test.ts tests/per_marketplace_offer_flow.test.ts

cd "/Users/tutul/Downloads/AIR OTC/middleman-agent"
npm run typecheck
npx vitest run tests/per_permission_activation_fallback.test.ts tests/negotiation_rollup_service_fallback.test.ts tests/meridian_client_reconnect_durability.test.ts tests/observatory_bridge_auth.test.ts
npm run test:pipeline:critical
npm run test:component:e2e
npm test

cd "/Users/tutul/Downloads/AIR OTC/escrow"
cargo check -p escrow-confidential
cargo test -p escrow-confidential
anchor build -p escrow-confidential
```

The full live proof command requires configured devnet wallets and external services:

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
AIROTC_TRADE_PRICE_SOL=0.001 \
AIROTC_TRADE_COLLATERAL_SOL=0.0001 \
AIROTC_TRADE_AMOUNT=1 \
AIROTC_REQUIRE_FULL_UMBRA=true \
UMBRA_SETTLEMENT_LIFECYCLE_MODE=FULL_UMBRA \
AIROTC_REQUIRE_ZERION=true \
AIROTC_ZERION_ONLINE_CHECK_MODE=light \
AGENT_LOOP_DELAY_MS=2500 \
AGENT_MAX_LOOPS=360 \
npm run proof:full-pipeline
```

Expected result: the proof exits `0`, the ticket reaches completed status, the audit includes strict PER and full Umbra lifecycle events, and Torque sidecar delivery is sent for both participants.

## Demo walkthrough

1. Open the observatory frontend and show dashboard, marketplace, agents, explorer, and docs.
2. Explain the four product surfaces: SDK, runtime, observatory, MCP.
3. Show the latest full-pipeline ticket ID and proof status.
4. Show the evidence registry mapping claims to code and commands.
5. Explain why the strongest claim is devnet-proven strict PER, not mainnet production readiness.

## Honest limitations

- AIR OTC is devnet submission-ready, not mainnet production-ready.
- It is trust-minimized and privacy-hardened, not fully trustless.
- Native SOL entry and exit remain public on Solana even when strict PER uses shielded internal credit.
- Python PER has real workflow entrypoints, but Python-side Encrypt FHE ciphertext generation is not independently live-proven.
- Mixed Python/TypeScript live PER is not yet recorded as a devnet proof.
- SDK-only full-pipeline was attempted on 2026-05-10 and failed closed until `AIROTC_ZERION_EXTERNAL_TX` or `AIROTC_ZERION_EXECUTE_REAL_TX=true` is supplied.
- The frontend is an observatory, not the agent execution surface.

## Submission files

Start here:

1. [NEW_SUBMISSION_CHECKLIST.md](/Users/tutul/Downloads/AIR OTC/NEW_SUBMISSION_CHECKLIST.md)
2. [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
3. [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
4. [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
5. [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
6. [docs/HOW_TO_VERIFY.md](/Users/tutul/Downloads/AIR OTC/docs/HOW_TO_VERIFY.md)
7. [docs/JUDGE_DEMO_SCRIPT.md](/Users/tutul/Downloads/AIR OTC/docs/JUDGE_DEMO_SCRIPT.md)
8. [SUBMISSION_FINAL_REPORT.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_FINAL_REPORT.md)
9. [docs/proof-evidence/README.md](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/README.md)

Use [.submissionignore](/Users/tutul/Downloads/AIR OTC/.submissionignore) when preparing a clean public archive.
