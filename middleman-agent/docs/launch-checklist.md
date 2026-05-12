# Launch Checklist

Use this checklist before a high-confidence deploy, demo, or reviewer session.

## Configuration

- `PER_STRICT_OPAQUE_MODE=true`
- `ENABLE_LEGACY_UMBRA_STEALTH_LIFECYCLE=false`
- `ENABLE_SIMULATION_ROUTES=false`
- `ALLOW_DEMO_RUNTIME_LISTENERS=false`
- `NEXT_PUBLIC_ENABLE_SIMULATION_ROUTES=false`
- `BRIDGE_SECRET` is configured in both `api-server` and `middleman-agent`

## Dependency health

- Solana RPC reachable
- MagicBlock TEE reachable
- MagicBlock auth reachable
- Encrypt reachable
- IKA reachable

## Proof gates

Run:

```bash
cd /Users/tutul/Downloads/AIR OTC/middleman-agent
npm run test:phase8:gate
```

Then run:

```bash
npm run test:marketplace:observatory:proof
STABILITY_CAMPAIGN_RUNS=3 npm run test:stability:campaign
```

## Runtime posture

- no plaintext PER logs appear during proof runs
- buyer-only PER gate blocks correctly
- observatory bridge writes are signed and authenticated
- marketplace PER read surfaces stay redacted after match
- simulation routes return `404` unless explicitly enabled

## Evidence package

Keep these local artifacts for demos, audits, or grants:

- latest local diagram-soak summary
- latest local stability-campaign summary
- latest strict PER live proof output
- latest marketplace + observatory proof output

For the public submission bundle, use sanitized summaries under `docs/proof-evidence/` instead of raw local logs.

## Do not launch if

- `test:phase8:gate` is red
- `test:stability:campaign` is red
- dependency health is degraded on critical vendors
- demo flags are enabled in a production environment
