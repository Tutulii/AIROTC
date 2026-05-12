# PER Finalization Contract

Canonical MagicBlock PER devnet contract for AIR OTC.

Verified on April 24, 2026 from MagicBlock developer guidance and live E2E runs.

## Canonical Devnet Targets

- TEE RPC: `https://devnet-tee.magicblock.app`
- TEE WS: `wss://devnet-tee.magicblock.app`
- TEE validator: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`

## Supported Finalization Sequence

1. Execute `preparePrivateHandoff` on the TEE.
2. Submit `commit + undelegate` on the TEE, not on base layer.
3. Poll base layer until the delegated session owner returns to the negotiation program.
4. Submit `ClosePermission` on base layer only after undelegation is complete.

## Important Constraints

- Do not submit permission commit on L1 for a delegated PER session.
- The delegated account owner or the configured permission authority manages finalization.
- The close step is invalid until undelegation back to L1 has completed.
- Shared runtime constants live in:
  - `/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/magicblockPerContract.ts`

## Runtime References

- Finalization service:
  - `/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/privateNegotiationService.ts`
- Rollup orchestrator:
  - `/Users/tutul/Downloads/AIR OTC/middleman-agent/src/services/negotiationRollupService.ts`
- Live proof test:
  - `/Users/tutul/Downloads/AIR OTC/middleman-agent/test/per_redaction_e2e_test.ts`
