import { PublicKey } from "@solana/web3.js";

/**
 * Canonical MagicBlock PER devnet contract.
 *
 * Source of truth confirmed with MagicBlock dev guidance on 2026-04-24:
 * 1. Commit + undelegation is submitted on the PER / TEE connection.
 * 2. ClosePermission happens only after the delegated account is back on L1.
 * 3. The delegated account owner or permission authority manages finalization.
 */
export const PER_TEE_VALIDATOR_FQDN = "devnet-tee.magicblock.app";
export const PER_TEE_RPC_URL = `https://${PER_TEE_VALIDATOR_FQDN}`;
export const PER_TEE_WS_URL = `wss://${PER_TEE_VALIDATOR_FQDN}`;
export const PER_TEE_VALIDATOR_DEVNET = new PublicKey(
    "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);

export const PER_FINALIZATION_SEQUENCE = [
    "prepare private handoff on TEE",
    "commit + undelegate on TEE",
    "wait for L1 owner restoration",
    "close permission on L1",
] as const;
