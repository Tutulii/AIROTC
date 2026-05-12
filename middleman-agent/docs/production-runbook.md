# Production Runbook

This runbook is the operational companion to the production verification matrix for the `AIR OTC` stack.

Related operator docs:

- [production-verification-matrix.md](/Users/tutul/Downloads/AIR%20OTC/middleman-agent/docs/production-verification-matrix.md)
- [production-env-matrix.md](/Users/tutul/Downloads/AIR%20OTC/middleman-agent/docs/production-env-matrix.md)
- [launch-checklist.md](/Users/tutul/Downloads/AIR%20OTC/middleman-agent/docs/launch-checklist.md)
- [incident-playbook.md](/Users/tutul/Downloads/AIR%20OTC/middleman-agent/docs/incident-playbook.md)

## Stack topology

- `frontend`
  - public marketplace + docs UI
- `api-server`
  - offer creation, listing, accept flow, ticket APIs, middleman bridge
- `middleman-agent`
  - wallet-auth WebSocket gateway, ER/PER orchestration, confidential settlement pipeline
- `escrow`
  - confidential Anchor programs and release/dispute enforcement

## Production-mode assumptions

- `PER_STRICT_OPAQUE_MODE=true`
- `ENABLE_LEGACY_UMBRA_STEALTH_LIFECYCLE=false`
- `ENABLE_SIMULATION_ROUTES=false`
- `ALLOW_DEMO_RUNTIME_LISTENERS=false`
- `rollupMode=PER` tickets use SDK rollup negotiation for numeric agreement
- server-side PER funding and release payloads remain redacted

## Required operator inputs

- Solana RPC endpoint
- funded operator keypair for devnet/proving environments
- MagicBlock auth + TEE access
- Encrypt access
- IKA / dWallet access
- Umbra receiver registrations for participating wallets
- database + Prisma connectivity for `api-server`

## Startup order

1. start database and confirm Prisma connectivity
2. start `api-server`
3. start `middleman-agent`
4. start `frontend`
5. verify wallet-auth WebSocket handshake with a buyer/seller SDK client

## Release/dispute state machine

Canonical PER release flow:

1. both parties approve settlement plan
2. buyer confirms final release
3. seller dispute window opens
4. if no dispute, middleman marks `release_authorized`
5. IKA / dWallet signs
6. confidential escrow executes `reveal_and_release`

Hard production rules:

- plain chat must not authorize PER release
- middleman must not supply payout amounts
- disputes must block release until resolved

## Final deploy gate

Run this command before high-confidence deploy or demo sign-off:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:phase8:gate
```

This command proves:

- `api-server` compiles without cross-package source imports
- no known plaintext PER promotion path is active
- marketplace-backed PER remains redacted
- PER buyer-only approval gate blocks correctly
- harness-backed live proof and soak still pass on the current external stack

For a structured repeatability campaign on top of the final gate:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
STABILITY_CAMPAIGN_RUNS=3 npm run test:stability:campaign
```

## Supporting proof commands

Strict opaque PER local proof:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:per:strict:e2e
```

Marketplace-backed PER proof pack:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:marketplace:per:proof
```

This is the marketplace contract/redaction proof pack, not the literal live settlement runtime proof. Use `npm run test:diagram:live` for the harness-backed live downstream flow.

Live private PER proof:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:per:strict:live
```

Repeatability / soak:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
DIAGRAM_SOAK_RUNS=5 DIAGRAM_SOAK_SCENARIOS=private_blocked,full_happy_path npm run test:diagram:soak
```

Extended stability campaign:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
STABILITY_CAMPAIGN_RUNS=3 npm run test:stability:campaign
```

## Failure classification

Do not treat every red run as a product regression. Classify the failure first:

- `magicblock_tee`
- `magicblock_auth`
- `encrypt`
- `ika`
- `solana_rpc`
- `umbra`
- `internal_pipeline`
- `unknown`

## Incident handling

### MagicBlock TEE / auth outage

Symptoms:

- TEE verification failures
- permission activation stalls
- auth or quote endpoints failing

Operator action:

- pause private-route blame/debugging
- capture timestamp + failing stage
- rerun only after MagicBlock status recovers

### Solana RPC instability

Symptoms:

- `fetch failed`
- signature status timeouts
- balance fetch failures

Operator action:

- retry with the existing RPC failover path
- keep the failing signature, endpoint, and timestamp in incident notes

### Encrypt / IKA outages

Symptoms:

- gRPC unavailable
- co-sign or settlement approval timeouts

Operator action:

- classify as external dependency issue unless local regression is reproduced
- rerun component E2Es separately before changing core pipeline logic

## Manual dispute handling

If a seller opens a dispute:

1. freeze release
2. inspect the deal ticket, session PDA, and approval state
3. resolve by policy/manual operator decision
4. require fresh approvals before resuming release

## Rollback posture

If Phase 8 gate turns red due to a local regression:

1. stop deploy/demo claims
2. keep `PER_STRICT_OPAQUE_MODE=true`
3. do not re-enable legacy Umbra lifecycle as a shortcut; it is test-only and not a production rollback path
4. reproduce with:
   - `npm run test:per:strict:e2e`
   - `npm run test:marketplace:per:proof`
   - `npm run test:per:strict:live`
5. classify whether the break is:
   - proof-layer only
   - marketplace bridge
   - funding
   - release/dispute
   - external infra

## Definition-of-done checklist

- marketplace PER offer flow remains redacted after match
- middleman continues PER from proof/commitments, not plaintext terms
- funding and release requests remain server-redacted
- SDK local private-term hydration stays required
- buyer-only release remains blocked without seller settlement-plan approval
- payout math remains on-chain
- seller balance-readiness remains explicitly non-custodial
- strict PER local proof pack is green
- marketplace PER proof pack is green
- live private PER proof is green
- soak gate is green
