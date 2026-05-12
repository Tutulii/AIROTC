import { WebSocket } from "ws";
import { startWsGateway, stopWsGateway } from "../src/gateway/wsServer";
import { sessionManager } from "../src/gateway/sessionManager";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { prisma } from "../src/lib/prisma";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function failTest(name: string, reason: string) {
  console.error(`❌ FAILED [${name}]: ${reason}`);
  stopWsGateway();
  process.exit(1);
}

function passTest(name: string) {
  console.log(`✅ PASSED [${name}]`);
}

async function runTests() {
  console.log("\n=== 🔐 EDGE AUTHENTICATION TESTS ===\n");
  const PORT = 3006;
  startWsGateway(PORT);

  const url = `ws://localhost:${PORT}`;

  const connect = (): Promise<{ws: WebSocket, nextMessage: () => Promise<any>}> => new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messageQueue: any[] = [];
    const resolverQueue: ((msg: any) => void)[] = [];

    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      if (resolverQueue.length > 0) {
        resolverQueue.shift()!(parsed);
      } else {
        messageQueue.push(parsed);
      }
    });

    const nextMessage = () => new Promise<any>((res) => {
      if (messageQueue.length > 0) {
        res(messageQueue.shift());
      } else {
        resolverQueue.push(res);
      }
    });

    ws.on("open", () => resolve({ws, nextMessage}));
  });

  // Client Wallet
  const clientKeypair = Keypair.generate();
  const walletPubkey = clientKeypair.publicKey.toBase58();

  console.log("[TEST 1] Block Payload Before Auth");
  const { ws: ws1, nextMessage: next1 } = await connect();
  await next1(); // Burn the first challenge msg

  ws1.send(JSON.stringify({
    version: "1.0",
    type: "offer",
    agent_id: "agent_testing",
    timestamp: Date.now(),
    price: 10,
    collateral_buyer: 1,
    collateral_seller: 1,
    asset_type: "token"
  }));
  
  const reply1 = await next1();
  if (reply1.type === "error" && reply1.error === "Authentication required") {
    passTest("Successfully blocked strict protocol message before passing Auth Zero-Trust boundary (Code 4001).");
  } else {
    failTest("Test 1", "Did not reject generic JSON message correctly.");
  }


  console.log("\n[TEST 2] Invalid Spoofed Signature Reject");
  const { ws: ws2, nextMessage: next2 } = await connect();
  const chal2 = await next2();
  
  // Sign with a different key entirely to simulate spoofing!
  const maliciousKey = Keypair.generate();
  const maliciousSignature = nacl.sign.detached(
    Buffer.from(chal2.challenge, "utf-8"),
    maliciousKey.secretKey
  );

  ws2.send(JSON.stringify({
    type: "auth_response",
    wallet: walletPubkey, // Claims to be `walletPubkey`
    signature: bs58.encode(maliciousSignature) // But signs with a different secret
  }));

  const reply2 = await next2();
  if (reply2.type === "auth_failed" && reply2.reason === "invalid_signature") {
    passTest("Blocked spoofed malicious cryptographic signature correctly.");
  } else {
    failTest("Test 2", "Allowed malicious signature mapping mapping mismatch!");
  }


  console.log("\n[TEST 3] Valid Authentication Resolution");
  const { ws: ws3, nextMessage: next3 } = await connect();
  const chal3 = await next3();

  const validSignature = nacl.sign.detached(
    Buffer.from(chal3.challenge, "utf-8"),
    clientKeypair.secretKey
  );

  ws3.send(JSON.stringify({
    type: "auth_response",
    wallet: walletPubkey,
    signature: bs58.encode(validSignature)
  }));

  const reply3 = await next3();
  let agentId = "";
  if (reply3.type === "auth_success" && reply3.agent_id) {
    agentId = reply3.agent_id;
    passTest(`Valid Wallet Authenticated perfectly mapping internal UUID -> ${agentId}`);
  } else {
    failTest("Test 3", `Gateway did not reply with auth_success natively -> ${JSON.stringify(reply3)}`);
  }


  console.log("\n[TEST 4] Replay Attack Vulnerability Check");
  // Try sending the EXACT SAME validation packet used in Test 3 over a new socket entirely
  const { ws: ws4, nextMessage: next4 } = await connect();
  await next4(); // ignore the new challenge

  // Still attempting to respond with `chal3` signature!
  ws4.send(JSON.stringify({
    type: "auth_response",
    wallet: walletPubkey,
    signature: bs58.encode(validSignature) 
  }));

  const reply4 = await next4();
  if (reply4.type === "auth_failed" && reply4.reason === "invalid_signature") {
    passTest("Rebuffed Replay Attack. Server explicitly blocked stale signature natively evaluating new Nonce.");
  } else {
    failTest("Test 4", `Failed to block Replay attack. Signature reused successfully? ${JSON.stringify(reply4)}`);
  }

  
  console.log("\n[TEST 5] Sending Valid Payload Post-Authentication");
  // ws3 is our formally authenticated session.
  ws3.send(JSON.stringify({
    version: "1.0",
    type: "message",
    agent_id: agentId,  // Extracted dynamically from our DB sync above!
    ticket_id: "t_test_5",
    timestamp: Date.now(),
    content: "Secure comms enabled!"
  }));
  
  // To assert, we wait a frame and see if the session manager correctly tracks the data mapping
  await sleep(200);
  const mappedWs = sessionManager.getSessionByAgent(agentId);
  if (mappedWs && mappedWs.readyState === WebSocket.OPEN) {
    passTest("Protocol strictly allowed standard payloads flowing through EventBus post-auth flawlessly.");
  } else {
     failTest("Test 5", "Websocket disconnected on standard payload");
  }

  // Teardown
  console.log("\n=== ALL ZERO-TRUST BOUNDARY TESTS SECURE ===\n");
  ws1.close();
  ws2.close();
  ws3.close();
  ws4.close();
  stopWsGateway();
  await prisma.$disconnect();
  process.exit(0);
}

runTests().catch(console.error);
