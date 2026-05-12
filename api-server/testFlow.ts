// @ts-nocheck
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const API_URL = 'http://localhost:3000';

function createAuthPayload(keypair: Keypair, data: any) {
    const message = `Sign this message to authenticate for AgentOTC at ${Date.now()}`;
    const messageUint8 = new TextEncoder().encode(message);
    const signatureUint8 = nacl.sign.detached(messageUint8, keypair.secretKey);

    return {
        ...data,
        message,
        signature: bs58.encode(signatureUint8),
        publicKey: keypair.publicKey.toBase58()
    };
}

async function runTest() {
    console.log("=== STARTING MANUAL TEST FLOW ===");

    const seller = Keypair.generate();
    const buyer = Keypair.generate();

    console.log("Seller Wallet:", seller.publicKey.toBase58());
    console.log("Buyer Wallet:", buyer.publicKey.toBase58());

    // 1. Create offer
    console.log("\n[1] Creating Offer (Seller)");
    const offerPayload = createAuthPayload(seller, {
        asset: "SOL",
        price: 150.5,
        amount: 10,
        mode: "sell",
        collateral: 200
    });

    const createRes = await fetch(`${API_URL}/v1/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(offerPayload)
    });

    if (!createRes.ok) {
        console.error("Failed to create offer:", await createRes.text());
        process.exit(1);
    }
    const createData: any = await createRes.json();
    const offerId = createData.data.id;
    console.log("✅ Offer Created => ID:", offerId);

    // 2. Accept offer from another wallet
    console.log(`\n[2] Accepting Offer from another wallet (Buyer) -> ${offerId}`);
    const acceptPayload = createAuthPayload(buyer, {});
    const acceptRes = await fetch(`${API_URL}/v1/offers/${offerId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acceptPayload)
    });

    if (!acceptRes.ok) {
        console.error("Failed to accept offer:", await acceptRes.text());
        process.exit(1);
    }
    const acceptData: any = await acceptRes.json();
    console.log("✅ Offer Accepted First Time!");
    console.log("Ticket Created:", acceptData.ticket);

    // 3. Try accepting AGAIN
    console.log(`\n[3] Accepting Offer AGAIN (Buyer 2 expected to FAIL with 409 conflict)`);
    const buyer2 = Keypair.generate();
    const acceptPayload2 = createAuthPayload(buyer2, {});
    const acceptRes2 = await fetch(`${API_URL}/v1/offers/${offerId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(acceptPayload2)
    });

    if (acceptRes2.status === 409) {
        console.log(`✅ SUCCESS! Expected 409 Conflict accurately returned for double acceptance.`);
    } else {
        console.log(`❌ FAILURE! Expected 409, got ${acceptRes2.status}`);
        process.exit(1);
    }

    // 4. Test GET /v1/tickets/:id (Unauthorized)
    console.log(`\n[4] Fetching Ticket -> ${acceptData.ticket.id} with unauthorized wallet`);
    const hacker = Keypair.generate();
    const fetchPayload = createAuthPayload(hacker, {});
    const payloadStr = JSON.stringify(fetchPayload);

    // Node 18+ native fetch strictly forbids body in GET.
    // Instead of using fetch, we can use the http module to forcefully send a GET body if needed,
    // or we can test the service directly if we don't want to mess with raw sockets.
    // Actually, since authenticateSolana only reads from req.body, a GET fetch with body throwing is a problem.
    // Let's use standard node http request to simulate a generic client that allows GET bodies (like fetch in some runtimes or older axios)
    const http = require('http');
    const getOptions = {
        hostname: 'localhost',
        port: 3000,
        path: `/v1/tickets/${acceptData.ticket.id}`,
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payloadStr)
        }
    };

    const req = http.request(getOptions, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 403) {
                console.log(`✅ SUCCESS! Expected 403 accurately returned for unauthorized wallet.`);
            } else {
                console.log(`❌ FAILURE! Expected 403, got ${res.statusCode}`);
                console.log(data);
                process.exit(1);
            }
        });
    });

    req.write(payloadStr);
    req.end();

    // Using a promise to pause execution for the async http.request before proceeding
    await new Promise(resolve => setTimeout(resolve, 500));

    // 5. Send message from Seller
    console.log(`\n[5] Sending Message from Seller`);
    const messagePayload = createAuthPayload(seller, {
        content: "Hello from the seller! This is my first message."
    });

    const sendRes = await fetch(`${API_URL}/v1/tickets/${acceptData.ticket.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messagePayload)
    });

    if (!sendRes.ok) {
        console.error("Failed to send message:", await sendRes.text());
        process.exit(1);
    }
    const sendData: any = await sendRes.json();
    console.log("✅ Message Created successfully:", sendData.message.content);

    // 6. Try sending message from Hacker
    console.log(`\n[6] Sending Message from Hacker (Expected 403)`);
    const hackMessagePayload = createAuthPayload(hacker, {
        content: "I am a hacker trying to send a message!"
    });

    const hackSendRes = await fetch(`${API_URL}/v1/tickets/${acceptData.ticket.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hackMessagePayload)
    });

    if (hackSendRes.status === 403) {
        console.log(`✅ SUCCESS! Expected 403 Forbidden accurately returned for unauthorized message send.`);
    } else {
        console.log(`❌ FAILURE! Expected 403, got ${hackSendRes.status}`);
        process.exit(1);
    }

    // Using a promise to pause execution for the async http.request before proceeding
    await new Promise(resolve => setTimeout(resolve, 500));

    // 7. Fetch Messages (Buyer)
    console.log(`\n[7] Fetching Messages (Buyer)`);
    const fetchMsgsPayload = createAuthPayload(buyer, {});
    const msgsPayloadStr = JSON.stringify(fetchMsgsPayload);

    const getMsgsOptions = {
        hostname: 'localhost',
        port: 3000,
        path: `/v1/tickets/${acceptData.ticket.id}/messages`,
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(msgsPayloadStr)
        }
    };

    const msgsReq = http.request(getMsgsOptions, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 200) {
                console.log(`✅ SUCCESS! Fetched messages successfully.`);
                const parsed = JSON.parse(data);
                console.log("Messages List:", parsed.messages);
            } else {
                console.log(`❌ FAILURE! Expected 200, got ${res.statusCode}`);
                console.log(data);
                process.exit(1);
            }
        });
    });

    msgsReq.write(msgsPayloadStr);
    msgsReq.end();

    await new Promise(resolve => setTimeout(resolve, 500));

    // 8. WebSocket Tests
    console.log(`\n[8] Testing Real-time WS Connections`);
    const ioClient = require("socket.io-client");

    // Test 8A: Unauthorized Connection
    console.log("   [8A] Testing WS Unauthorized Connection");
    const badWsClient = ioClient.io(`http://localhost:3000`, {
        auth: {
            wallet: hacker.publicKey.toBase58(),
            signature: "invalid",
            message: "invalid"
        }
    });

    const badWsPromise = new Promise((resolve) => {
        badWsClient.on("connect_error", (err: any) => {
            console.log(`✅ SUCCESS! Expected Connect Error (Unauthorized):`, err.message);
            badWsClient.close();
            resolve(true);
        });
        badWsClient.on("connect", () => {
            console.log(`❌ FAILURE! Unauthorized client connected!`);
            process.exit(1);
        });
    });
    await badWsPromise;

    // Test 8B: Authorized Connection & Room Join
    console.log("\n   [8B] Testing WS Authorized Connection & Room Join");
    const validBuyerPayloadObj = createAuthPayload(buyer, {});
    const buyerWsClient = ioClient.io(`http://localhost:3000`, {
        auth: {
            wallet: validBuyerPayloadObj.publicKey,
            signature: validBuyerPayloadObj.signature,
            message: validBuyerPayloadObj.message
        }
    });

    const goodWsPromise = new Promise((resolve) => {
        buyerWsClient.on("connect", () => {
            buyerWsClient.emit("join_ticket", { ticketId: acceptData.ticket.id });
        });

        buyerWsClient.on("joined_ticket", (data: any) => {
            console.log(`✅ SUCCESS! WS accurately joined ticket room:`, data.ticketId);
            buyerWsClient.close();
            resolve(true);
        });

        buyerWsClient.on("error", (err: any) => {
            console.log(`❌ FAILURE! WS Join Error!`, err);
            process.exit(1);
        });

        buyerWsClient.on("connect_error", (err: any) => {
            console.log(`❌ FAILURE! WS Failed to connect:`, err.message);
            process.exit(1);
        });
    });

    await goodWsPromise;

    // Test 8C: Authorized Connection but Unauthorized Room Join
    console.log("\n   [8C] Testing WS Unauthorized Room Join (Cross-ticket)");
    const validHackerPayloadObj = createAuthPayload(hacker, {});
    const hackerWsClient = ioClient.io(`http://localhost:3000`, {
        auth: {
            wallet: validHackerPayloadObj.publicKey,
            signature: validHackerPayloadObj.signature,
            message: validHackerPayloadObj.message
        }
    });

    const hackerWsPromise = new Promise((resolve) => {
        hackerWsClient.on("connect", () => {
            hackerWsClient.emit("join_ticket", { ticketId: acceptData.ticket.id });
        });

        hackerWsClient.on("joined_ticket", (data: any) => {
            console.log(`❌ FAILURE! Hacker WS joined ticket room perfectly:`, data.ticketId);
            process.exit(1);
        });

        hackerWsClient.on("error", (err: any) => {
            console.log(`✅ SUCCESS! WS Join securely blocked for cross-ticket context:`, err.message);
            hackerWsClient.close();
            resolve(true);
        });
    });

    await hackerWsPromise;

    // 9. Real-Time Broadcast Integration Check
    console.log(`\n[9] Testing Real-Time Message Broadcast Flow`);

    // Connect both agents
    const b2Payload = createAuthPayload(buyer, {});
    const s2Payload = createAuthPayload(seller, {});

    const bWs = ioClient.io(`http://localhost:3000`, {
        auth: { wallet: b2Payload.publicKey, signature: b2Payload.signature, message: b2Payload.message }
    });
    const sWs = ioClient.io(`http://localhost:3000`, {
        auth: { wallet: s2Payload.publicKey, signature: s2Payload.signature, message: s2Payload.message }
    });

    let targetEvents = 4;
    let eventsReceived = 0;

    const broadcastPromise = new Promise(async (resolve) => {
        const checkDone = () => {
            if (eventsReceived === targetEvents) {
                console.log(`✅ SUCCESS! Broadcast completely verified across multiple connected agents along with Presence Events.`);
                bWs.close();
                sWs.close();
                resolve(true);
            }
        };

        // Listen for new messages
        bWs.on("new_message", (msg: any) => {
            console.log(`   [Buyer WS] Received new_message:`, msg.content);
            eventsReceived++;
            checkDone();
        });

        bWs.on("typing", (data: any) => {
            console.log(`✅ SUCCESS! Buyer WS intercepted typing indicator: isTyping=${data.isTyping}`);
            eventsReceived++;
            checkDone();
        });

        bWs.on("messages_read", (data: any) => {
            console.log(`✅ SUCCESS! Buyer WS intercepted read receipt:`, data.messageIds);
            eventsReceived++;
            checkDone();
        });

        sWs.on("new_message", (msg: any) => {
            console.log(`   [Seller WS] Received new_message:`, msg.content);
            eventsReceived++;

            // 10. Presence Testing dynamically fired by Seller right after receiving the broadcast
            sWs.emit("read_messages", { ticketId: acceptData.ticket.id, messageIds: [msg.id] });
            sWs.emit("typing", { ticketId: acceptData.ticket.id, isTyping: true });

            checkDone();
        });

        // Join rooms
        let joinedCount = 0;
        const joinCheck = async () => {
            joinedCount++;
            if (joinedCount === 2) {
                // Both connected and joined. Fire the REST payload.
                console.log(`   Both agents listening to ticket. Firing REST POST /messages...`);
                const restMsgPayload = createAuthPayload(seller, { content: "LFG! Real-time broadcast test." });
                const postRes = await fetch(`${API_URL}/v1/tickets/${acceptData.ticket.id}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(restMsgPayload)
                });
                if (!postRes.ok) {
                    console.log(`❌ FAILURE! REST firing failed:`, postRes.status);
                    process.exit(1);
                }
            }
        };

        bWs.on("joined_ticket", joinCheck);
        sWs.on("joined_ticket", joinCheck);

        bWs.on("connect", () => bWs.emit("join_ticket", { ticketId: acceptData.ticket.id }));
        sWs.on("connect", () => sWs.emit("join_ticket", { ticketId: acceptData.ticket.id }));

        bWs.on("connect_error", (err: any) => console.log('Buyer ws failed:', err.message));
        sWs.on("connect_error", (err: any) => console.log('Seller ws failed:', err.message));
    });

    await broadcastPromise;

    // 11. Deal API Endpoint Integrity Testing
    console.log(`\n[11] Testing On-Chain Deal Resolver Safety Bounds`);

    // 11A. Bad Format Base58
    console.log(`   [11A] Testing Invalid Deal ID String`);
    const badIdRes = await fetch(`${API_URL}/v1/deals/malformed-not-valid`);
    if (badIdRes.status === 400) console.log(`✅ SUCCESS! Safely caught 400 Bad Request on invalid keys.`);
    else { console.log(`❌ FAILURE! Expected 400, got ${badIdRes.status}`); process.exit(1); }

    // 11B. Wrong Program Owner (Using Native System Program)
    console.log(`   [11B] Testing Arbitrary Program Ownership Spoofing`);
    const spoofRes = await fetch(`${API_URL}/v1/deals/11111111111111111111111111111111`);
    if (spoofRes.status === 400) console.log(`✅ SUCCESS! Safely caught 400 Invalid Owner. Escrow program bound cleanly.`);
    else { console.log(`❌ FAILURE! Expected 400, got ${spoofRes.status}`); process.exit(1); }

    // 11C. Non-existent Account (Random Pubkey)
    console.log(`   [11C] Testing Non-existent Account Fetch`);
    const emptyAcct = Keypair.generate().publicKey.toBase58();
    const noAcctRes = await fetch(`${API_URL}/v1/deals/${emptyAcct}`);
    if (noAcctRes.status === 404) console.log(`✅ SUCCESS! Safely caught 404 Account Not Found.`);
    else { console.log(`❌ FAILURE! Expected 404, got ${noAcctRes.status}`); process.exit(1); }

    // 12. Forensic Transaction Endpoint Integration
    console.log(`\n[12] Testing Forensic Real-Time Transactions Reconstructor`);
    // Testing on the same valid Empty Account to check 200 empty array flow
    const forensicRes = await fetch(`${API_URL}/v1/deals/${emptyAcct}/transactions`);
    if (forensicRes.status === 200) {
        const forensicData: any = await forensicRes.json();
        console.log(`✅ SUCCESS! Safely intercepted transaction history accurately bounded tracking bounds: length=${forensicData.transactions.length}`);
    } else {
        console.log(`❌ FAILURE! Expected 200, got ${forensicRes.status}`);
        process.exit(1);
    }


    // 13. Agent Registration
    console.log(`\n[13] Testing Agent Registration Identity Loop`);
    const newAgent = Keypair.generate().publicKey.toBase58();

    // 13A. New Wallet
    console.log(`   [13A] Registering new Agent wallet`);
    const regRes = await fetch(`${API_URL}/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: newAgent })
    });
    if (regRes.ok) {
        const regData: any = await regRes.json();
        if (regData.created === true) console.log(`✅ SUCCESS! New agent accurately registered.`);
        else { console.log(`❌ FAILURE! Expected created: true`); process.exit(1); }
    } else { console.log(`❌ FAILURE! Expected 200, got ${regRes.status}`); process.exit(1); }

    // 13B. Existing Wallet
    console.log(`   [13B] Registering Existing Agent wallet (Idempotent Check)`);
    const regRes2 = await fetch(`${API_URL}/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: newAgent })
    });
    if (regRes2.ok) {
        const regData2: any = await regRes2.json();
        if (regData2.created === false) console.log(`✅ SUCCESS! Idempotent mapping successfully caught duplicate agent silently.`);
        else { console.log(`❌ FAILURE! Expected created: false`); process.exit(1); }
    } else { console.log(`❌ FAILURE! Expected 200, got ${regRes2.status}`); process.exit(1); }

    // 13C. Invalid Wallet
    console.log(`   [13C] Registering Invalid Agent wallet`);
    const regRes3 = await fetch(`${API_URL}/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: "invalid_base58_string" })
    });
    if (regRes3.status === 400) console.log(`✅ SUCCESS! Bounced malformed wallet safely.`);
    else { console.log(`❌ FAILURE! Expected 400, got ${regRes3.status}`); process.exit(1); }

    // 14. Agent Profiles Evaluation
    console.log(`\n[14] Testing Agent Profile Lookup Mechanics`);
    // 14A. Valid Wallet Zero Deals (Should return 0 computes inherently)
    console.log(`   [14A] Looking up valid wallet with 0 deals`);
    const profRes1 = await fetch(`${API_URL}/v1/agents/${newAgent}`);
    if (profRes1.ok) {
        const profData: any = await profRes1.json();
        if (profData.metrics.successRate === 0 && profData.wallet === newAgent) console.log(`✅ SUCCESS! Safely intercepted empty 0/0 rates returning safely.`);
        else { console.log(`❌ FAILURE! Computation math corrupt on zeroes.`); process.exit(1); }
    } else { console.log(`❌ FAILURE! Expected 200, got ${profRes1.status}`); process.exit(1); }

    // 14B. Invalid Wallet format string 
    console.log(`   [14B] Looking up badly formatted pubkey strings`);
    const profRes2 = await fetch(`${API_URL}/v1/agents/baddi-wllti`);
    if (profRes2.status === 400) {
        console.log(`✅ SUCCESS! Expected 400 exactly caught mapped cleanly.`);
    } else { console.log(`❌ FAILURE! Expected 400, got ${profRes2.status}`); process.exit(1); }

    // 14C. Non existent Valid Key mapping 404 precisely
    console.log(`   [14C] Looking up valid but undiscovered pubkey`);
    const noAgent = Keypair.generate().publicKey.toBase58();
    const profRes3 = await fetch(`${API_URL}/v1/agents/${noAgent}`);
    if (profRes3.status === 404) {
        console.log(`✅ SUCCESS! Bounced unseen wallet cleanly returning 404.`);
    } else { console.log(`❌ FAILURE! Expected 404, got ${profRes3.status}`); process.exit(1); }

    console.log("=== END OF TEST ===");
    process.exit(0);
}

runTest().catch(console.error);
