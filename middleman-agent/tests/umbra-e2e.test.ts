/**
 * Umbra Privacy SDK — E2E Devnet Test Suite
 *
 * Validates the Umbra integration against real Solana devnet.
 * Same rigor as our Encrypt E2E tests — devnet is truth, no mocks.
 *
 * Source of truth for all function calls:
 *   - https://sdk.umbraprivacy.com/quickstart
 *   - SDK .d.ts type signatures (verified from node_modules)
 *
 * Environment variables required:
 *   - PAYER_SECRET_KEY: JSON array of 64 bytes (funded devnet keypair)
 *   - SOLANA_RPC_URL: Solana devnet RPC (defaults to public devnet)
 *
 * Run:
 *   PAYER_SECRET_KEY='[...]' npx vitest run tests/umbra-e2e.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import bs58 from "bs58";
import {
    UmbraService,
    UMBRA_SUPPORTED_MINTS,
    UMBRA_PROGRAM_IDS,
} from "../src/services/umbraService";
import { loadConfig } from "../src/config";

// ============================================================================
// TEST CONFIG
// ============================================================================

const NETWORK = "devnet" as const;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

/**
 * Load test keypair from environment.
 * Same pattern as encrypt-e2e.test.ts — fail-closed if not provided.
 */
function loadKeypairBytes(): Uint8Array {
    const raw = process.env.PAYER_SECRET_KEY || loadConfig().privateKey;
    
    // Auto-detect base58 string format exported by Phantom/Solflare
    if (!raw.trim().startsWith('[')) {
        return bs58.decode(raw.trim());
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 64) {
        throw new Error(`PAYER_SECRET_KEY must be 64 bytes, got ${parsed.length}`);
    }
    return new Uint8Array(parsed);
}

// ============================================================================
// EVIDENCE LOG
// ============================================================================

const evidence: Record<string, unknown> = {
    network: NETWORK,
    rpcUrl: RPC_URL,
    programId: UMBRA_PROGRAM_IDS[NETWORK],
    timestamp: new Date().toISOString(),
    tests: {} as Record<string, unknown>,
};

function logEvidence(testName: string, data: Record<string, unknown>) {
    (evidence.tests as Record<string, unknown>)[testName] = {
        ...data,
        timestamp: new Date().toISOString(),
    };
    console.log(`\n[EVIDENCE] ${testName}:`, JSON.stringify(data, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

// ============================================================================
// TESTS
// ============================================================================

describe("Umbra Privacy SDK — Devnet E2E", () => {
    let service: UmbraService;
    let keypairBytes: Uint8Array;

    beforeAll(() => {
        keypairBytes = loadKeypairBytes();
        service = new UmbraService(keypairBytes, RPC_URL, NETWORK);
    });

    // ────────────────────────────────────────────────────────────────────────
    // Test 1: Client Creation
    // Source: https://sdk.umbraprivacy.com/sdk/creating-a-client
    // ────────────────────────────────────────────────────────────────────────

    it("1. should create Umbra client on devnet", async () => {
        await service.initClient();
        const address = service.getAddress();

        expect(address).toBeTruthy();
        expect(typeof address).toBe("string");
        expect(address.length).toBeGreaterThan(30); // Solana base58 address

        logEvidence("client_creation", {
            status: "PASS",
            address,
            network: NETWORK,
        });
    }, 30_000);

    // ────────────────────────────────────────────────────────────────────────
    // Test 2: Client is idempotent
    // ────────────────────────────────────────────────────────────────────────

    it("2. should be idempotent on repeated initClient calls", async () => {
        const addressBefore = service.getAddress();
        await service.initClient(); // Second call
        const addressAfter = service.getAddress();

        expect(addressAfter).toBe(addressBefore);

        logEvidence("client_idempotent", {
            status: "PASS",
            address: addressAfter,
        });
    }, 10_000);

    // ────────────────────────────────────────────────────────────────────────
    // Test 3: Registration
    // Source: https://sdk.umbraprivacy.com/sdk/registration
    //
    // 3-step idempotent flow:
    //   1. Create on-chain EncryptedUserAccount PDA
    //   2. Register X25519 encryption key
    //   3. Store user commitment in Merkle tree
    // ────────────────────────────────────────────────────────────────────────

    it("3. should register account (confidential + anonymous)", async () => {
        const signatures = await service.ensureRegistered();

        // May be empty if already registered from a previous run
        expect(Array.isArray(signatures)).toBe(true);

        logEvidence("registration", {
            status: "PASS",
            tx_count: signatures.length,
            signatures,
        });
    }, 120_000); // Registration can take multiple txs

    // ────────────────────────────────────────────────────────────────────────
    // Test 4: Registration is idempotent
    // ────────────────────────────────────────────────────────────────────────

    it("4. should skip registration on second call", async () => {
        const signatures = await service.ensureRegistered();

        // Should return empty — our service-level cache prevents redundant calls
        expect(signatures).toEqual([]);

        logEvidence("registration_idempotent", {
            status: "PASS",
            signatures,
        });
    }, 10_000);

    // ────────────────────────────────────────────────────────────────────────
    // Test 5: Query User Account State
    // Source: https://sdk.umbraprivacy.com/sdk/query#query-user-account
    // ────────────────────────────────────────────────────────────────────────

    it("5. should query user account state after registration", async () => {
        const accountState = await service.queryUserAccount();

        // After registration, account should exist
        expect(accountState).toBeTruthy();

        logEvidence("account_state_query", {
            status: "PASS",
            account_exists: !!accountState,
            account_state: accountState,
        });
    }, 30_000);

    // ────────────────────────────────────────────────────────────────────────
    // Test 6: Query Encrypted Balance (before deposit)
    // Source: https://sdk.umbraprivacy.com/sdk/query#query-encrypted-balance
    //
    // On devnet, we test with wSOL (native SOL wrapped).
    // The balance query should return state metadata.
    // ────────────────────────────────────────────────────────────────────────

    it("6. should query encrypted balance metadata for wSOL", async () => {
        const balanceState = await service.queryEncryptedBalance(
            UMBRA_SUPPORTED_MINTS.wSOL
        );

        // This could be null/non_existent if no prior deposit was made
        // We're just verifying the query doesn't throw
        logEvidence("balance_query", {
            status: "PASS",
            mint: "wSOL",
            balance_state: balanceState,
        });
    }, 30_000);

    // ────────────────────────────────────────────────────────────────────────
    // Test 7: Scan for incoming UTXOs
    // Source: https://sdk.umbraprivacy.com/sdk/mixer/fetching-utxos
    // ────────────────────────────────────────────────────────────────────────

    it("7. should scan for incoming UTXOs without error", async () => {
        const startedAt = Date.now();
        const result = await service.scanIncomingUtxos(0, 0);

        expect(result).toBeTruthy();
        expect(Array.isArray(result.received)).toBe(true);

        logEvidence("utxo_scan", {
            status: "PASS",
            tree_index: 0,
            received_count: result.received.length,
            duration_ms: Date.now() - startedAt,
        });
    }, 90_000);

    // ────────────────────────────────────────────────────────────────────────
    // Evidence Summary
    // ────────────────────────────────────────────────────────────────────────

    it("8. should produce complete evidence log", () => {
        console.log("\n" + "=".repeat(80));
        console.log("UMBRA E2E EVIDENCE LOG");
        console.log("=".repeat(80));
        console.log(JSON.stringify(evidence, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
        console.log("=".repeat(80));

        // All required fields present
        expect(evidence.network).toBe(NETWORK);
        expect(evidence.programId).toBe(UMBRA_PROGRAM_IDS[NETWORK]);
        expect(evidence.timestamp).toBeTruthy();
    });
});
