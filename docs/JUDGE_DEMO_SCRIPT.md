# AIR OTC Judge Demo Script

Last updated: 2026-05-10

Target length: 3-5 minutes.

## 0:00-0:30 — Problem

Autonomous agents can find counterparties, but private OTC settlement is still messy: public terms leak strategy, delivery is hard to prove, and a judge or operator needs a clean evidence trail after the trade.

AIR OTC solves that on Solana devnet with agent-to-agent OTC settlement, private execution records, encrypted delivery, and proof bundles that map every claim to a ticket.

## 0:30-1:15 — Product Surfaces

Show the four surfaces:

- SDKs for builders: TypeScript is the flagship live path; Python has parity models and fail-closed PER helpers.
- No-code runtime for operators: config-driven `init`, `validate`, `start`, and `proof pair`.
- MCP server for external AI agents and operator tooling.
- Observatory frontend for humans: dashboard, marketplace, agents, explorer, and docs.

State the boundary clearly: the frontend observes. Agents execute through SDK, runtime, or MCP workflows.

## 1:15-2:15 — Live Observatory

Open the frontend and show:

- Dashboard: latest proof panel and live system state.
- Marketplace: public offer discovery; PER terms stay private after acceptance.
- Agents: registered agent directory.
- Explorer: deal lifecycle and on-chain state.
- Docs: proof IDs, setup commands, and honest boundaries.

If the backend is offline, say so directly. Offline screens are not live evidence; they are only the observatory shell.

## 2:15-3:30 — Proof Command And Ticket Evidence

Show the flagship proof command:

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

Then show the latest ticket:

- ticket: `13e6ae1d-68d0-46f0-a50a-6329965b598c`
- offer: `5024c326-3b75-4d7f-9aba-75c4aad05adb`
- escrow PDA: `5PrqGPyMspsPehK2h1PVpo3Fd4R2Pdo4TyAdqhmi7h9K`
- audit: valid with `45` entries
- timeline: completed with `62` events

Explain what it proves: Zerion online gate, strict PER, shielded-credit funding, encrypted seller delivery, buyer release confirmation, full Umbra lifecycle, and Torque sidecar delivery.

## 3:30-4:30 — Honest Boundaries

Say exactly:

AIR OTC is 100% devnet submission-ready, not mainnet production-ready. It is trust-minimized and privacy-hardened, not fully trustless. SDK-only full-pipeline needs real or external Zerion transaction evidence, and Python-side independent FHE ciphertext generation is future work.

Close with the credibility point: every submitted claim maps to code, command, ticket ID, and evidence registry entry.
