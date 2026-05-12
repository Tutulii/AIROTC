import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AgentOTC } from './src/index';

// Test setup using existing config or falling back strictly to random identities
// Note: For real buys, the wallet must be funded on devnet.
const testWallet = Keypair.generate();
console.log(`[TEST] Generated ephemeral test wallet: ${testWallet.publicKey.toBase58()}`);

async function runTest() {
    try {
        console.log("=== Testing AgentOTC TypeScript SDK ===");
        
        // 1. Initialize Client
        const client = new AgentOTC({
            apiKey: 'mk_test_123', // Doesn't perfectly matter if we stub or hit local
            walletPrivateKey: bs58.encode(testWallet.secretKey),
            environment: 'localnet' 
        });

        // 2. Connect
        console.log("Connecting...");
        await client.connect();
        console.log("✅ WebSocket Connected & Authenticated");

        // 3. Test Offer Listing
        console.log("Fetching offers...");
        const offers = await client.offers.list({ mode: 'sell', status: 'active' });
        console.log(`✅ Retrieved ${offers.length} active global offers.`);
        
        // Cleanup connection
        client.disconnect();
        console.log("✅ SDK Smoke Test Successful.");

    } catch (e: any) {
        console.error("❌ SDK Test Failed:");
        console.error(e.message || e);
        process.exit(1);
    }
}

runTest();
