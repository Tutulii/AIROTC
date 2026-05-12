import { PublicKey } from "@solana/web3.js";
import { permissionPdaFromAccount, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

function runTest() {
    console.log("==========================================");
    console.log("  Permission PDA Derivation Test ");
    console.log("==========================================\n");

    // 1. Generate a mock Session PDA
    const sessionPda = PublicKey.unique();
    console.log(`[TEST] Using mock Session PDA: ${sessionPda.toBase58()}`);

    // 2. Derive using the MagicBlock SDK helper
    const sdkDerivedPda = permissionPdaFromAccount(sessionPda);
    console.log(`[TEST] SDK permissionPdaFromAccount: ${sdkDerivedPda.toBase58()}`);

    // 3. Independent derivation using our assumed seeds
    const [independentlyDerivedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("permission:"), sessionPda.toBuffer()],
        PERMISSION_PROGRAM_ID
    );
    console.log(`[TEST] Independent findProgramAddressSync: ${independentlyDerivedPda.toBase58()}`);

    // 4. Compare
    console.log("\n==========================================");
    if (sdkDerivedPda.equals(independentlyDerivedPda)) {
        console.log("✅ MATCH: The PDA derivation is exactly as expected.");
    } else {
        console.log("❌ MISMATCH: We need to investigate the SDK source code.");
    }
    console.log("==========================================");
}

runTest();
