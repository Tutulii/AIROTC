import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import bs58 from "bs58";
import dotenv from "dotenv";

import { setProvider } from "@coral-xyz/anchor";
import * as path from "path";
import * as fs from "fs";

// Load environment variables
dotenv.config();

// Load the IDL securely via absolute path to avoid missing module errors
const idlPath = path.join(__dirname, "../../escrow/target/idl/escrow.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

// ==========================================
// 1. CONNECTION SETUP
// ==========================================
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");

// ==========================================
// 2. WALLET LOADING
// ==========================================
function loadAgentWallet(): Wallet {
    const rawKey = process.env.AGENT_PRIVATE_KEY;
    if (!rawKey) {
        throw new Error("[SolanaConfig] Missing AGENT_PRIVATE_KEY environment variable.");
    }

    try {
        // Attempt to parse as JSON Array
        const keyArray = JSON.parse(rawKey);
        const secretKey = new Uint8Array(keyArray);
        const keypair = Keypair.fromSecretKey(secretKey);
        return new Wallet(keypair) as Wallet;
    } catch (e: any) {
        // Fallback: Attempt to parse as base58 string
        try {
            const secretKey = bs58.decode(rawKey);
            const keypair = Keypair.fromSecretKey(secretKey);
            return new Wallet(keypair) as Wallet;
        } catch (err: any) {
            throw new Error("[SolanaConfig] Failed to parse AGENT_PRIVATE_KEY. Must be a JSON array or a valid base58 string.");
        }
    }
}

export const wallet = loadAgentWallet();

// ==========================================
// 3. PROVIDER SETUP
// ==========================================
export const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
});
setProvider(provider);

// ==========================================
// 4. PROGRAM LOADING
// ==========================================
const programIdStr = process.env.ESCROW_PROGRAM_ID || (idl as any).metadata?.address || (idl as any).address;
if (!programIdStr) {
    throw new Error("[SolanaConfig] Missing Escrow Program ID. Provide it in .env as ESCROW_PROGRAM_ID or within the IDL.");
}

export const programId = new PublicKey(programIdStr);
(idl as any).address = programIdStr; // Ensure IDL has address for Anchor 0.32
export const program = new Program(idl as any, provider);

// ==========================================
// 5. VALIDATION FUNCTION
// ==========================================
export async function testSolanaConnection() {
    try {
        const pubkey = wallet.publicKey;
        
        // STEP 1 - BASIC CONNECTION CHECK
        const balance = await connection.getBalance(pubkey);

        // STEP 2 - NETWORK HEALTH CHECK
        const version = await connection.getVersion();

        // STEP 3 - PROGRAM VALIDATION (CRITICAL)
        const accountInfo = await connection.getAccountInfo(program.programId);
        if (accountInfo === null) {
            throw new Error("Escrow program not found on-chain");
        }

        // STEP 4 - PROGRAM TYPE CHECK (IMPORTANT)
        if (accountInfo.executable !== true) {
            throw new Error("Program ID is not executable (invalid program)");
        }

        // STEP 5 - STRUCTURED LOGGING
        console.log(JSON.stringify({
            event: "onchain_validation",
            wallet: pubkey.toBase58(),
            balance: balance,
            program_id: program.programId.toBase58(),
            program_found: true,
            executable: true,
            cluster: String(version["solana-core"]),
            status: "success"
        }, null, 2));

        // STEP 7 - RETURN VALUE
        return true;
    } catch (error: any) {
        // STEP 6 - ERROR HANDLING
        console.error(JSON.stringify({
            event: "onchain_validation",
            status: "failed",
            error: error.message || error.toString()
        }, null, 2));
        
        throw error;
    }
}

// STEP 8 - FINAL EXECUTION TEST
// Temporarily call at the bottom
testSolanaConnection();
