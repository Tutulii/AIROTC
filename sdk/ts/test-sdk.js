const { AgentOTC } = require('./dist/index.js');

async function runTest() {
    try {
        console.log("=== Testing AgentOTC TypeScript SDK ===");
        const walletPrivateKey = process.env.AGENTOTC_TEST_WALLET_PRIVATE_KEY;
        if (!walletPrivateKey) {
            throw new Error("Set AGENTOTC_TEST_WALLET_PRIVATE_KEY to run this live SDK smoke test.");
        }
        
        const client = new AgentOTC({
            apiKey: process.env.AGENTOTC_TEST_API_KEY || 'mk_test_123',
            walletPrivateKey,
            environment: 'localnet' 
        });

        client.on('error', (err) => {
             console.log(`[SDK Event] Captured background error: ${err.message}`);
        });

        console.log("Connecting...");
        await client.connect();
        console.log("✅ WebSocket Connected & Authenticated");

        console.log("Fetching offers...");
        const offers = await client.offers.list({ mode: 'sell', status: 'active' });
        console.log(`✅ Retrieved ${offers.length} active global offers.`);
        
        client.disconnect();
        console.log("✅ SDK Smoke Test Successful.");
        process.exit(0);

    } catch (e) {
        console.error("❌ SDK Test Failed:");
        console.error(e.message || e);
        process.exit(1);
    }
}

runTest();
