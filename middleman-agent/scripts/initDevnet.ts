/**
 * Devnet Initialization Script
 * 
 * Checks and initializes the escrow program on Solana devnet:
 * 1. Verifies the escrow program exists on devnet
 * 2. Checks if the config PDA is already initialized
 * 3. If not, calls initialize_config to create it
 * 4. Checks wallet balance and requests airdrop if needed
 * 
 * Usage: npx ts-node scripts/initDevnet.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../src/config";
import { loadWallet } from "../src/solana/wallet";

async function main() {
    console.log("\n═══════════════════════════════════════");
    console.log("  AIR OTC — Devnet Initialization");
    console.log("═══════════════════════════════════════\n");

    const config = loadConfig();
    const connection = new Connection(config.solanaRpcUrl, "confirmed");
    const keypair = loadWallet(config.privateKey);
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

    console.log(`Network:  ${config.network}`);
    console.log(`RPC:      ${config.solanaRpcUrl}`);
    console.log(`Wallet:   ${keypair.publicKey.toBase58()}`);
    console.log(`Program:  ${config.programId}`);

    // ── Step 1: Check wallet balance ──
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    console.log(`\n1. Wallet balance: ${balanceSol.toFixed(4)} SOL`);

    if (balanceSol < 0.5) {
        console.log("   ⚠️  Low balance. Requesting airdrop...");
        try {
            const sig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig, "confirmed");
            const newBalance = await connection.getBalance(keypair.publicKey);
            console.log(`   ✅ Airdrop success. New balance: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        } catch (e: any) {
            console.log(`   ❌ Airdrop failed: ${e.message}`);
            console.log("   💡 Try manually: solana airdrop 2 " + keypair.publicKey.toBase58() + " --url devnet");
        }
    } else {
        console.log("   ✅ Balance sufficient.");
    }

    // ── Step 2: Verify program exists ──
    console.log("\n2. Checking escrow program on devnet...");
    const programId = new PublicKey(config.programId);
    try {
        const programInfo = await connection.getAccountInfo(programId);
        if (programInfo) {
            console.log(`   ✅ Program found (${programInfo.data.length} bytes, executable: ${programInfo.executable})`);
        } else {
            console.log("   ❌ Program NOT found on devnet!");
            console.log("   💡 Deploy with: anchor deploy --provider.cluster devnet");
            process.exit(1);
        }
    } catch (e: any) {
        console.log(`   ❌ Error checking program: ${e.message}`);
        process.exit(1);
    }

    // ── Step 3: Check config PDA ──
    console.log("\n3. Checking config PDA...");
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programId
    );
    console.log(`   Config PDA: ${configPda.toBase58()}`);

    const configAccount = await connection.getAccountInfo(configPda);
    if (configAccount) {
        console.log("   ✅ Config PDA already initialized.");
    } else {
        console.log("   ⚠️  Config PDA not initialized. Initializing...");
        try {
            const idlPath = process.env.IDL_PATH || path.join(__dirname, "../../escrow/target/idl/escrow.json");
            const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
            (idl as any).address = config.programId;
            const program = new Program(idl as any, provider);

            const tx = await (program.methods as any).initializeConfig()
                .accounts({
                    config: configPda,
                    authority: keypair.publicKey,
                    systemProgram: PublicKey.default,
                })
                .rpc();

            console.log(`   ✅ Config initialized! TX: ${tx}`);
        } catch (e: any) {
            if (e.message?.includes("already in use")) {
                console.log("   ✅ Config was already initialized (race condition safe).");
            } else {
                console.log(`   ❌ Failed to initialize config: ${e.message}`);
                process.exit(1);
            }
        }
    }

    // ── Step 4: Summary ──
    console.log("\n═══════════════════════════════════════");
    console.log("  ✅ Devnet Initialization Complete");
    console.log("═══════════════════════════════════════");
    console.log("  You can now start the middleman agent:");
    console.log("  npx ts-node src/index.ts");
    console.log("═══════════════════════════════════════\n");
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
