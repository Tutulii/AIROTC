# Incident Playbook

Use this when a production proof, demo, or live run goes red.

## First response

1. classify the failure before changing code
2. capture the failing command, timestamp, and log artifact
3. note which dependency class failed:
   - `magicblock_tee`
   - `magicblock_auth`
   - `encrypt`
   - `ika`
   - `solana_rpc`
   - `umbra`
   - `internal_pipeline`
   - `proof_pack`
   - `unknown`

## Command-level triage

If the main gate fails:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:phase7:proof
npm run test:per:strict:live
npm run test:diagram:live
```

If you need repeatability context:

```bash
STABILITY_CAMPAIGN_RUNS=3 npm run test:stability:campaign
```

## Dependency-specific guidance

### `magicblock_tee`

- do not blame the local PER pipeline first
- confirm MagicBlock status
- keep the failing session stage and timestamp

### `magicblock_auth`

- verify auth token flow and TTL reuse
- capture TLS/auth errors exactly
- do not treat auth outages as escrow-logic bugs

### `solana_rpc`

- keep the failing RPC endpoint, signature, and timestamp
- retry after failover before changing core logic

### `encrypt` / `ika`

- rerun component proofs separately
- classify as vendor-path degradation unless a local regression is reproducible

### `internal_pipeline`

- rerun strict PER proof and marketplace proof
- inspect approval state, ticket state, and latest private handoff proof

## Rollback rules

- keep `PER_STRICT_OPAQUE_MODE=true`
- never re-enable the legacy Umbra lifecycle as a shortcut
- never enable demo runtime listeners in production as a workaround
- never enable simulation routes in production to bypass a real flow

## Recovery criteria

Only call the incident resolved when:

- the dependency is healthy again or the local fix is merged
- `test:phase8:gate` is green
- `test:stability:campaign` is green
- the latest artifact summaries are updated
