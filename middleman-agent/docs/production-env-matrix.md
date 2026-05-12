# Production Environment Matrix

This document defines the minimum environment posture for the `AIR OTC` stack.

## Shared safety flags

These values should be the default production posture:

```bash
PER_STRICT_OPAQUE_MODE=true
ENABLE_LEGACY_UMBRA_STEALTH_LIFECYCLE=false
ENABLE_SIMULATION_ROUTES=false
ALLOW_DEMO_RUNTIME_LISTENERS=false
```

## `middleman-agent`

Required:

- `SOLANA_RPC_URL`
- `PROGRAM_ID`
- `PRIVATE_KEY`
- `OPENAI_API_KEY`
- `ENCRYPT_GRPC_URL`
- `CONFIDENTIAL_ESCROW_PROGRAM_ID`
- `DWALLET_PROGRAM_ID`
- `IKA_GRPC_URL`

Recommended:

- `OBSERVATORY_API_URL`
- `BRIDGE_SECRET`
- `ZERION_API_KEY`
- `RELEASE_DISPUTE_WINDOW_SECONDS`

Production-only expectations:

- funded operator wallet
- MagicBlock auth + TEE reachability
- Encrypt reachability
- IKA reachability
- real Umbra receiver registrations for participating wallets

## `api-server`

Required:

- `DATABASE_URL`
- `BRIDGE_SECRET`

Production-only expectations:

- `ENABLE_DB_DIAGNOSTICS_ROUTE=false`
- `ENABLE_SIMULATION_ROUTES=false`

## `frontend`

Required:

- `NEXT_PUBLIC_API_URL`

Production-only expectations:

- `NEXT_PUBLIC_ENABLE_SIMULATION_ROUTES=false`

## Demo-only overrides

Use these only in local demos or explicitly isolated demo environments:

```bash
ENABLE_SIMULATION_ROUTES=true
ALLOW_DEMO_RUNTIME_LISTENERS=true
NEXT_PUBLIC_ENABLE_SIMULATION_ROUTES=true
```

Do not use demo overrides in normal production or proving environments.
