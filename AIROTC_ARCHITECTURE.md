# AIR OTC Architecture

Last updated: 2026-05-10

This is the canonical architecture document for the current repository state.

## 1. Product contract

AIR OTC is currently organized around four distinct surfaces:

1. **Technical SDKs**
   - TypeScript SDK for the fullest current integration surface
   - Python SDK for technical automation, ER workflows, and fail-closed PER parity helpers

2. **No-code runtime**
   - a TypeScript/Node CLI wrapper around the public SDK
   - config-driven startup for buyer, seller, watcher, and maker roles

3. **Human observatory**
   - a read-only frontend for monitoring agents, offers, deals, and docs

4. **MCP agent/operator interface**
   - scoped stdio and HTTP tools for external AI agents and operators

This separation is intentional:

- agents execute through SDKs or the runtime
- humans observe through the frontend
- external AI agents and operators can inspect or drive approved flows through MCP scopes

## 2. Repository map

### Public integration surfaces

- TypeScript SDK: [/Users/tutul/Downloads/AIR OTC/sdk/ts](</Users/tutul/Downloads/AIR OTC/sdk/ts>)
- Python SDK: [/Users/tutul/Downloads/AIR OTC/sdk/python](</Users/tutul/Downloads/AIR OTC/sdk/python>)
- No-code runtime: [/Users/tutul/Downloads/AIR OTC/runtime/air-otc](</Users/tutul/Downloads/AIR OTC/runtime/air-otc>)
- ElizaOS agents: [/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent](</Users/tutul/Downloads/AIR OTC/agents/elizaos-agent>)
- MCP server: [/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server](</Users/tutul/Downloads/AIR OTC/mcp/air-otc-server>)

### Core backend and settlement path

- API server: [/Users/tutul/Downloads/AIR OTC/api-server](</Users/tutul/Downloads/AIR OTC/api-server>)
- Middleman runtime: [/Users/tutul/Downloads/AIR OTC/middleman-agent](</Users/tutul/Downloads/AIR OTC/middleman-agent>)
- Escrow programs: [/Users/tutul/Downloads/AIR OTC/escrow](</Users/tutul/Downloads/AIR OTC/escrow>)

### Human observatory

- Frontend: [/Users/tutul/Downloads/AIR OTC/frontend](</Users/tutul/Downloads/AIR OTC/frontend>)

## 3. High-level system diagram

```text
External Agent
  ├─ TypeScript SDK
  ├─ Python SDK
  ├─ No-code Runtime
  ├─ ElizaOS Agent
  └─ MCP Agent / Operator
          │
          ▼
      API Server
          │
          ▼
   Middleman / Pipeline
          │
          ├─ Zerion verification
          ├─ MagicBlock ER / PER
          ├─ Umbra settlement routing
          ├─ Encrypt / confidential handoff
          ├─ Anchor escrow programs
          ├─ IKA approval/signing path
          └─ Torque post-settlement rewards
          │
          ▼
      Settlement
          │
          ▼
  Human Observatory Frontend
```

## 4. Trade execution path

### ER path

The public trade path is the simpler execution path:

1. agent registers and connects
2. agent posts or accepts an ER offer
3. the shared pipeline creates and progresses the deal
4. both sides fund the deal
5. delivery happens
6. settlement completes
7. Torque receives post-settlement events

### PER path

The current flagship path is PER:

1. agent registers and connects
2. seller posts a PER offer or buyer accepts one
3. the deal reaches rollup readiness
4. private agreement terms are finalized through PER methods
5. confidential/private funding flow runs
6. seller delivers through encrypted DM
7. buyer confirms private delivery
8. shielded-credit settlement completes
9. full-Umbra lifecycle evidence can complete shield / UTXO / claim / unshield
10. Torque receives post-settlement events

## 5. SDK architecture

### TypeScript SDK

The TypeScript SDK currently exposes:

- low-level namespaces:
  - `offers`
  - `agents`
  - `deal`
  - `dm`
- high-level workflows:
  - `quickBuyEr`
  - `quickSellEr`
  - `quickBuyPer`
  - `quickSellPer`
  - `runBuyerFlow`
  - `runSellerFlow`

The TypeScript SDK is the strongest current technical integration surface and owns the flagship PER workflow.

### Python SDK

The Python SDK currently exposes:

- low-level agent, offer, and deal operations
- ER workflow helpers
- PER protocol models and hash/serialization helpers
- `LivePerClient`
- `quick_buy_per`, `quick_sell_per`, `run_buyer_flow(mode="PER")`, and `run_seller_flow(mode="PER")`
- shielded-credit funding, release approval, and Umbra evidence helpers
- a fail-closed boundary where Python requires encrypted terms or a prebuilt PER handoff bundle for private-term execution

The Python SDK is part of the supported technical surface. Its remaining PER boundary is Python-side Encrypt/FHE ciphertext creation, which is not independently live-proven.

## 6. No-code runtime architecture

The no-code runtime is implemented in TypeScript/Node on top of the public TypeScript SDK.

It adds:

- interactive setup wizard
- config loading and validation
- one-command role startup
- config-driven agent roles

Current CLI contract:

- `air-otc init`
- `air-otc validate`
- `air-otc start`
- `air-otc start --role buyer|seller|watcher|maker`
- `air-otc proof pair`

## 7. Observatory frontend architecture

The frontend is intentionally read-only and maps directly to the supplied design assets:

- `/` → Dashboard
- `/explorer` → Deal explorer
- `/marketplace` → Live offer board
- `/agents` → Agent directory
- `/docs` → Integration docs

This route contract is now the canonical product shape. The frontend is not the primary trading control plane for agents.

## 8. MCP architecture

The MCP server is an interface layer for local or hosted agents. It supports stdio and HTTP transports and exposes scoped tools for:

- offer listing, creation, and acceptance
- PER buyer and seller workflow entrypoints
- deal status and proof bundle reads
- vault and Umbra lifecycle status
- health checks

Mutating tools require explicit scopes. MCP must not be described as settlement consensus and must not return private keys, plaintext PER terms, or sealed private metadata.

## 9. Current external integrations

The current repository and backend flow integrate with:

- **Zerion** for verification
- **MagicBlock** for ER and PER negotiation/session flow
- **Umbra** for settlement privacy routing
- **Encrypt** for confidential handoff / encrypted deal-term handling
- **IKA** for authorization/signing in the release path
- **Torque** for post-settlement event and reward attribution

These integrations live primarily in:

- [/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services](</Users/tutul/Downloads/AIR OTC/middleman-agent/src/services>)

## 10. Current honest boundaries

These boundaries are part of the current architecture and should be stated clearly:

1. Python PER has real workflow entrypoints, but Python-side Encrypt FHE ciphertext generation is not independently live-proven
2. The frontend is observatory-only, not the primary execution surface
3. AIR OTC is trust-minimized and privacy-hardened, not fully trustless
4. Native SOL entry and exit remain public on Solana even with shielded internal PER funding
5. The shielded-credit program is deployed and live-proven on devnet for TypeScript SDK, ElizaOS, and soak paths; full automatic Umbra shield / UTXO / claim / unshield is live-recorded for the ElizaOS TypeScript path on ticket `f616b13e-f219-4926-94a3-29dcc65dddc9`
6. Mixed Python/TypeScript live PER is not yet recorded as a devnet proof

## 11. Verification snapshot

The current architecture document is backed by:

- TS SDK build: `cd "/Users/tutul/Downloads/AIR OTC/sdk/ts" && npm run build`
- Python SDK compile + PER golden vectors: `cd "/Users/tutul/Downloads/AIR OTC" && sdk/python/venv/bin/python -m compileall sdk/python/agentotc/src/agentotc && PYTHONPATH=sdk/python/agentotc/src sdk/python/venv/bin/python sdk/python/test_per_vectors.py`
- Escrow confidential program: `cd "/Users/tutul/Downloads/AIR OTC/escrow" && cargo check -p escrow-confidential && cargo test -p escrow-confidential && anchor build -p escrow-confidential`
- MCP server: `cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server" && npm run typecheck && npm run build && npm test && npm audit --audit-level=moderate`
- Runtime validation: `cd "/Users/tutul/Downloads/AIR OTC/runtime/air-otc" && npm run typecheck && npm run build`
- Frontend build: `cd "/Users/tutul/Downloads/AIR OTC/frontend" && npm run build`
- Middleman runtime safety gate: `cd "/Users/tutul/Downloads/AIR OTC/middleman-agent" && npm run typecheck && npx vitest run tests/per_permission_activation_fallback.test.ts tests/negotiation_rollup_service_fallback.test.ts tests/meridian_client_reconnect_durability.test.ts tests/observatory_bridge_auth.test.ts`
- Shielded-credit devnet deployment: program `BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj`, deploy signature `46iC8NNsUWrTPeHqtJuKjHuhAE2bXGqhAeDPiuP5yxqwM9MG29sSvKwC7A9r4et5Wj3EPP3QBXSta336maPwiCfT`
- Latest TypeScript SDK PER shielded-credit proof: settled ticket `876bef08-88fc-4c19-880c-974a06e43916`; valid audit includes `confidential_shielded_credit_settled`
- Latest Eliza external-agent PER shielded-credit proof: settled ticket `5826ad0a-04df-4d29-b5f8-d30563bf0752`; valid audit includes `confidential_shielded_credit_settled`
- Latest full-pipeline devnet proof: completed ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c`; bundle-safe summary at [docs/proof-evidence/full-pipeline/2026-05-10-ticket-13e6ae1d-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/full-pipeline/2026-05-10-ticket-13e6ae1d-summary.json)
- Latest fresh diagram-soak smoke: `2/2` passed on 2026-05-10; bundle-safe summary at [docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json)
- Historical full diagram soak: `10/10` passed on 2026-05-06; bundle-safe summary at [docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json)
- Latest no-code runtime PER proof: settled ticket `e2023f32-3b36-45be-b27b-d7ced1352317`

See also:

- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
- [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
