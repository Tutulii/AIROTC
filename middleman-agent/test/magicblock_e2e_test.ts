/**
 * MagicBlock E2E Test v3 — Phase 1 full negotiated terms routed through ER validator
 *
 * Fix from v1: Steps 3+4 now go through ConnectionMagicRouter
 * which routes to the ER validator where the delegated account lives.
 *
 * Flow:
 *   1. initializeSession  → L1 (creates Session PDA)
 *   2. delegateSession     → L1 (CPI to Delegation Program, transfers ownership)
 *   3. negotiateTerms      → ER (via ConnectionMagicRouter — sub-100ms)
 *   4. reachConsensus      → ER (program CPI commit+undelegate back to L1)
 *   5. Verify final state  → L1 (confirm price, asset, and both collateral values were committed back)
 */

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import {
    ConnectionMagicRouter,
    GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";
import * as path from "path";
import { rpcManager } from "../src/utils/rpcManager";
import { withRetry } from "../src/utils/retry";

// ── Load IDL ──
const idlPath = path.join(__dirname, "../src/idl/magicblock_negotiation.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

const PROGRAM_ID = new PublicKey("BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq");

// ── Load keypair ──
const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const wallet = new Wallet(payer);

function getL1Connection(): Connection {
    return rpcManager.getConnection("confirmed");
}

function getL1Program(): Program {
    const provider = new AnchorProvider(getL1Connection(), wallet, { commitment: "confirmed" });
    return new Program(idl as any, provider);
}

// ── Setup ER connection + Anchor ──
const ER_FQDN = "devnet-as.magicblock.app";
const erConnection = new ConnectionMagicRouter(`https://${ER_FQDN}`, {
    commitment: "confirmed",
});
const erProvider = new AnchorProvider(erConnection as any, wallet, { commitment: "confirmed" });
const erProgram = new Program(idl as any, erProvider);

// ── Derive session PDA ──
function deriveSessionPda(sessionId: bigint): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(sessionId);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), buf],
        PROGRAM_ID
    );
    return pda;
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function confirmErTransaction(
    connection: ConnectionMagicRouter,
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number
) {
    const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
    );

    if (confirmation.value.err) {
        throw new Error(
            `ER transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`
        );
    }
}

async function main() {
    let hasFailure = false;
    const agreedPriceLamports = 1_500_000_000;
    const buyerCollateralLamports = 250_000_000;
    const sellerCollateralLamports = 350_000_000;
    const agreedAsset = "SOL";

    console.log("═══════════════════════════════════════════════════════");
    console.log("  MagicBlock E2E Test v3 — Phase 1 Full ER Lifecycle");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Program:   ${PROGRAM_ID.toBase58()}`);
    console.log(`  Payer:     ${payer.publicKey.toBase58()}`);
    try {
        const balanceLamports = await withRetry(
            () => getL1Connection().getBalance(payer.publicKey),
            { label: "er_e2e_get_balance", step: "preflight_balance" }
        );
        console.log(`  Balance:   ${balanceLamports / 1e9} SOL`);
    } catch (error: any) {
        console.log(`  Balance:   unavailable (${error.message})`);
    }
    console.log(`  ER:        https://${ER_FQDN}`);
    console.log(`  L1 RPC:    ${rpcManager.getCurrentEndpoint()}`);
    console.log("");

    const sessionId = BigInt(Math.floor(Math.random() * 1_000_000_000));
    const sessionPda = deriveSessionPda(sessionId);

    console.log(`  Session ID:  ${sessionId}`);
    console.log(`  Session PDA: ${sessionPda.toBase58()}`);
    console.log("");

    // ═══ STEP 1: Initialize Session (L1) ═══
    console.log("── Step 1: initializeSession [L1] ──");
    try {
        const sig = await withRetry(
            () => (getL1Program().methods as any)
                .initializeSession(new BN(sessionId.toString()))
                .accountsPartial({
                    session: sessionPda,
                    buyer: payer.publicKey,
                })
                .rpc(),
            { label: "er_e2e_initialize_session", step: "initialize_session" }
        );
        console.log(`  ✅ Success: ${sig}`);
    } catch (err: any) {
        console.log(`  ❌ FAILED: ${err.message}`);
        if (err.logs) console.log("  Logs:", err.logs.slice(-5).join("\n       "));
        process.exit(1);
    }

    // Verify session on L1
    const preAccount = await withRetry(
        () => getL1Connection().getAccountInfo(sessionPda),
        { label: "er_e2e_pre_account_info", step: "pre_delegation_owner_check" }
    );
    console.log(`  Owner before delegation: ${preAccount?.owner.toBase58()}`);
    console.log("");

    // ═══ STEP 2: Delegate Session (L1 → ER) ═══
    console.log("── Step 2: delegateSession [L1 → ER] ──");
    try {
        const { identity } = await erConnection.getClosestValidator();
        const sig = await withRetry(
            () => (getL1Program().methods as any)
                .delegateSession()
                .accountsPartial({
                    payer: payer.publicKey,
                    validator: new PublicKey(identity),
                    session: sessionPda,
                })
                .rpc(),
            { label: "er_e2e_delegate_session", step: "delegate_session" }
        );
        console.log(`  ✅ Success: ${sig}`);
    } catch (err: any) {
        console.log(`  ❌ FAILED: ${err.message}`);
        if (err.logs) console.log("  Logs:", err.logs.slice(-5).join("\n       "));
        process.exit(1);
    }

    // Wait for delegation to propagate to ER
    console.log("  Waiting 3s for delegation to propagate...");
    await sleep(3000);

    // Verify delegation status
    try {
        const status = await erConnection.getDelegationStatus(sessionPda);
        console.log(`  Delegation status: isDelegated=${status.isDelegated}`);
    } catch (err: any) {
        console.log(`  ⚠️  getDelegationStatus error: ${err.message}`);
    }

    // Verify owner changed
    const postAccount = await withRetry(
        () => getL1Connection().getAccountInfo(sessionPda),
        { label: "er_e2e_post_account_info", step: "post_delegation_owner_check" }
    );
    console.log(`  Owner after delegation: ${postAccount?.owner.toBase58()}`);
    console.log("");

    // ═══ STEP 3: Negotiate Terms (through ER validator) ═══
    console.log("── Step 3: negotiateTerms [ER] ──");
    try {
        const sig = await (erProgram.methods as any)
            .negotiateTerms(
                new BN(agreedPriceLamports),
                agreedAsset,
                new BN(buyerCollateralLamports),
                new BN(sellerCollateralLamports)
            )
            .accountsPartial({
                session: sessionPda,
            })
            .rpc();
        console.log(`  ✅ Success: ${sig}`);
        console.log(
            `  Set price=1.5 SOL, asset=${agreedAsset}, buyerCollateral=${buyerCollateralLamports} lamports, sellerCollateral=${sellerCollateralLamports} lamports`
        );
    } catch (err: any) {
        console.log(`  ❌ FAILED: ${err.message}`);
        if (err.logs) console.log("  Logs:", err.logs.slice(-5).join("\n       "));
        hasFailure = true;
    }
    console.log("");

    // ═══ STEP 4: Commit + Undelegate (through ER → back to L1) ═══
    console.log("── Step 4: reachConsensus [ER → L1] ──");
    try {
        const reachConsensusIx = await getL1Program().methods
            .reachConsensus(new BN(sessionId.toString()))
            .accounts({
                payer: payer.publicKey,
            })
            .instruction();
        const tx = new Transaction().add(reachConsensusIx);

        // Fetch blockhash from ER and sign
        const { blockhash, lastValidBlockHeight } = await erConnection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = payer.publicKey;
        
        tx.sign(payer);

        const rawTx = tx.serialize();
        const commitSig = await erConnection.sendRawTransaction(rawTx, {
            skipPreflight: true, // ER-internal instruction — L1 simulation rejects delegated account writes
        });
        await confirmErTransaction(erConnection, commitSig, blockhash, lastValidBlockHeight);
        console.log(`  ✅ Commit signature: ${commitSig}`);

        // Track the L1 commitment — retry because ER schedules commits asynchronously
        let l1Sig: string | null = null;
        for (let attempt = 0; attempt < 15; attempt++) {
            try {
                await sleep(4000);
                l1Sig = await GetCommitmentSignature(commitSig, erConnection);
                console.log(`  ✅ L1 commitment: ${l1Sig} (attempt ${attempt + 1})`);
                break;
            } catch (err: any) {
                if (attempt === 14) {
                    console.log(`  ⚠️  L1 tracking failed after 15 attempts: ${err.message}`);
                } else {
                    console.log(`  ⏳ Attempt ${attempt + 1}: ${err.message}, retrying...`);
                }
            }
        }
    } catch (err: any) {
        console.log(`  ❌ FAILED: ${err.message}`);
        if (err.logs) console.log("  Logs:", err.logs.slice(-5).join("\n       "));
        hasFailure = true;
    }
    console.log("");

    // Wait for state to settle back on L1
    console.log("  Waiting 5s for L1 settlement...");
    await sleep(5000);

    // ═══ STEP 5: Verify Final State on L1 ═══
    console.log("── Step 5: Verify State [L1] ──");
    try {
        const account: any = await withRetry(
            () => (getL1Program().account as any).session.fetch(sessionPda),
            { label: "er_e2e_final_fetch", step: "verify_state" }
        );
        console.log(`  Session ID:    ${account.sessionId.toString()}`);
        console.log(`  Buyer:         ${account.buyer.toBase58()}`);
        console.log(`  Agreed Price:  ${account.agreedPrice.toString()} lamports`);
        console.log(`  Agreed Asset:  "${account.agreedAsset}"`);
        console.log(`  Buyer Collat.: ${account.buyerCollateral.toString()} lamports`);
        console.log(`  Seller Collat.: ${account.sellerCollateral.toString()} lamports`);
        console.log(`  Status:        ${JSON.stringify(account.status)}`);

        // Verify the negotiated terms were committed back to L1
        if (
            account.agreedPrice.toString() === agreedPriceLamports.toString() &&
            account.agreedAsset === agreedAsset &&
            account.buyerCollateral.toString() === buyerCollateralLamports.toString() &&
            account.sellerCollateral.toString() === sellerCollateralLamports.toString()
        ) {
            console.log(`  ✅ State committed back to L1 with full negotiated terms!`);
        } else {
            console.log(`  ⚠️  State may not have committed back yet.`);
            hasFailure = true;
        }
    } catch (err: any) {
        console.log(`  ⚠️  Could not fetch state: ${err.message}`);
        console.log(`  This may mean the account is still delegated (owned by DelegationProgram).`);
        hasFailure = true;
    }

    // Check final owner
    const finalAccount = await withRetry(
        () => getL1Connection().getAccountInfo(sessionPda),
        { label: "er_e2e_final_owner", step: "verify_final_owner" }
    );
    console.log(`  Final owner: ${finalAccount?.owner.toBase58()}`);
    if (!finalAccount?.owner.equals(PROGRAM_ID)) {
        hasFailure = true;
    }
    console.log("");

    console.log("═══════════════════════════════════════════════════════");
    console.log("  E2E Test v3 Complete");
    console.log("═══════════════════════════════════════════════════════");

    if (hasFailure) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
