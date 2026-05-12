# AIR OTC How To Verify

Last updated: 2026-05-10

This page is the judge-facing verification path. It separates local build confidence from live devnet proof evidence.

## 1. Local Green Gate

```bash
cd "/Users/tutul/Downloads/AIR OTC/frontend" && npm run build

cd "/Users/tutul/Downloads/AIR OTC/sdk/ts" && npm run build && npm run test

cd "/Users/tutul/Downloads/AIR OTC"
sdk/python/venv/bin/python -m compileall sdk/python/agentotc/src/agentotc
PYTHONPATH=sdk/python/agentotc/src sdk/python/venv/bin/python sdk/python/test_per_vectors.py

cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc" && npm run typecheck && npm run build

cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm run typecheck && npm run build && npm test && npm audit --audit-level=moderate

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

Expected result: all commands pass. The MCP audit should report `0` vulnerabilities at moderate level.

## 2. Fresh Devnet Proof Evidence

Flagship proof:

- command: `npm run proof:full-pipeline` from `agents/elizaos-agent` with strict PER, full Umbra, and Zerion env flags.
- ticket: `13e6ae1d-68d0-46f0-a50a-6329965b598c`
- status: `completed`
- audit: valid with `45` entries
- timeline: completed with `62` events

Supporting proofs:

- TypeScript SDK PER: `876bef08-88fc-4c19-880c-974a06e43916`
- ElizaOS PER: `5826ad0a-04df-4d29-b5f8-d30563bf0752`
- no-code runtime PER pair: `e2023f32-3b36-45be-b27b-d7ced1352317`

## 3. MCP Evidence Queries

Use the MCP tools against the live local API/middleman services:

- `airotc_get_deal_status` for ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c`
- `airotc_get_proof_bundle` for the same ticket
- `airotc_umbra_lifecycle_status` for the same ticket

Expected result: completed status, valid proof bundle, and `deal_pipeline_umbra_lifecycle_completed_confirmed`.

## 4. Soak Evidence

Historical full default soak:

- 2026-05-06: `npm run test:diagram:soak` completed `10/10`.

Fresh Day 2 smoke:

- 2026-05-10: `DIAGRAM_SOAK_RUNS=1 npm run test:diagram:soak` completed `2/2`.
- Bundle-safe summary: `/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json`.

Current Day 2 long-run attempt:

- 2026-05-10: default long soak reached `4/5` live passes but external devnet services interrupted completion.

Do not present a failed or interrupted external soak as a full green run.

## 5. Honest Limits

- Devnet submission-ready does not mean mainnet production-ready.
- The system is trust-minimized and privacy-hardened, not fully trustless.
- Native SOL entry and exit remain public.
- SDK-only full-pipeline requires real or external Zerion transaction evidence.
- Python-side independent FHE ciphertext generation remains future work.
