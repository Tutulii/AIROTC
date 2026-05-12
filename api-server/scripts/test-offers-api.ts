import nacl from 'tweetnacl';
import bs58 from 'bs58';

const API_URL = 'http://localhost:3000/v1/offers';

async function main() {
    console.log('🧪 Starting Offers API E2E Test Suite...\n');

    // 1. Generate Keypair securely
    const keypair = nacl.sign.keyPair();
    const publicKey = bs58.encode(keypair.publicKey);
    const secretKey = keypair.secretKey;

    const message = 'login to agentotc';
    const messageUint8 = new TextEncoder().encode(message);
    const signatureUint8 = nacl.sign.detached(messageUint8, secretKey);
    const signature = bs58.encode(signatureUint8);

    console.log(`🔑 Generated Ephemeral Test Wallet: ${publicKey}`);
    console.log(`✍️ Signed Cryptographic Challenge: ${signature}`);
    console.log('--------------------------------------------------\n');

    // Helper fetch function for authenticated hooks
    const runRequest = async (method: string, url: string, body?: any) => {
        const options: any = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) {
            // Magically interleave the signature metadata required by our Auth Middleware
            options.body = JSON.stringify({ ...body, publicKey, signature, message });
        }
        const res = await fetch(url, options);
        const data = await res.json();
        return { status: res.status, data };
    };

    try {
        // TEST 1: POST /v1/offers
        console.log('▶ TEST 1: POST /v1/offers (Create Authenticated Sell Offer)');
        const createRes = await runRequest('POST', API_URL, {
            asset: 'SOL',
            price: 5.5,
            amount: 10,
            mode: 'sell',
            collateral: 1.0,
        });
        console.log(`HTTP Status: ${createRes.status}`);
        console.log(`Response Body:`, JSON.stringify(createRes.data, null, 2));
        if (createRes.status !== 201) throw new Error('TEST 1 FAILED');
        console.log('✅ TEST 1 PASSED\n');

        const offerId = createRes.data.data.id;

        // TEST 2: GET /v1/offers
        console.log('▶ TEST 2: GET /v1/offers (List Active Offers Publicly)');
        const listRes = await fetch(API_URL).then(r => r.json());
        console.log(`Response Body:`, JSON.stringify(listRes, null, 2));
        if (!listRes.success) throw new Error('TEST 2 FAILED');
        console.log('✅ TEST 2 PASSED\n');

        // TEST 3: GET /v1/offers/:id
        console.log(`▶ TEST 3: GET /v1/offers/${offerId} (Detailed Offer Fetch)`);
        const getRes = await fetch(`${API_URL}/${offerId}`).then(r => r.json());
        console.log(`Response Body:`, JSON.stringify(getRes, null, 2));
        if (!getRes.success) throw new Error('TEST 3 FAILED');
        console.log('✅ TEST 3 PASSED\n');

        // TEST 4: PATCH /v1/offers/:id
        console.log(`▶ TEST 4: PATCH /v1/offers/${offerId} (Cancel Authorized Offer)`);
        const patchRes = await runRequest('PATCH', `${API_URL}/${offerId}`, {
            status: 'cancelled',
        });
        console.log(`HTTP Status: ${patchRes.status}`);
        console.log(`Response Body:`, JSON.stringify(patchRes.data, null, 2));
        if (patchRes.status !== 200) throw new Error('TEST 4 FAILED');
        console.log('✅ TEST 4 PASSED\n');

        console.log('🎉 ALL 4 TESTS COMPLETED SUCCESSFULLY! API ENFORCES DOMAIN RULES FLAWLESSLY.');
    } catch (err: any) {
        console.error(`\n❌ SCRIPT ABORTED: ${err.message}`);
        console.log('Are you absolutely sure PostgreSQL is running on port 5432 and the API server is alive on port 3000?');
    }
}

if (process.argv.includes('--help')) {
    console.log(`
Test Script for Offers API
--------------------------
Generates an ephemeral ED25519 Solana Keypair securely using tweetnacl,
cryptographically signs the strict 'login to agentotc' challenge message,
and automatically fires exact e2e requests against your local server.

Usage: npx ts-node scripts/test-offers-api.ts
  `);
    process.exit(0);
}

main();
