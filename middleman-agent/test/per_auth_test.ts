import { Connection, Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { PrivateNegotiationService } from "../src/services/privateNegotiationService";

async function main() {
    console.log("==========================================");
    console.log("  PER Integration - Day 1 Foundation Test ");
    console.log("==========================================\n");

    const connection = new Connection("https://api.devnet.solana.com");
    const serverPayer = Keypair.generate(); // Mock server
    const agentKeypair = Keypair.generate(); // Mock agent

    const perService = new PrivateNegotiationService(connection, serverPayer);

    console.log("[TEST] Verifying TEE RPC Integrity...");
    const isVerified = await perService.verifyTeeIntegrity();
    
    if (!isVerified) {
        console.error("❌ TEE RPC Integrity verification failed.");
        process.exit(1);
    }
    console.log("✅ TEE RPC Integrity verification passed (Intel TDX Confirmed).");

    console.log("\n[TEST] Requesting Auth Token for Agent...");
    try {
        const auth = await perService.getAgentAuthTokenPatternB(
            agentKeypair.publicKey,
            async (challengeBase64: string) => {
                const challenge = Buffer.from(challengeBase64, "base64");
                const signature = nacl.sign.detached(challenge, agentKeypair.secretKey);
                return Buffer.from(signature).toString("base64");
            }
        );
        console.log(`✅ Auth Token Acquired: ${auth.token.substring(0, 30)}...`);
    } catch (e: any) {
        console.error("❌ Failed to get Auth Token:", e.message);
        process.exit(1);
    }

    console.log("\n==========================================");
    console.log("  Day 1 Foundation Tests Passed! ");
    console.log("==========================================");
}

main().catch(console.error);
