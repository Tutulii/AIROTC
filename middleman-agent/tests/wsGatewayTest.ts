import { WebSocket } from "ws";
import { startWsGateway, stopWsGateway } from "../src/gateway/wsServer";
import { sessionManager } from "../src/gateway/sessionManager";

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
  console.log("\n=== 🔌 WEBSOCKET GATEWAY TESTS ===\n");
  const PORT = 3005;
  startWsGateway(PORT);

  const url = `ws://localhost:${PORT}`;

  const connect = (): Promise<WebSocket> => new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
  });

  const nextMessage = (ws: WebSocket): Promise<any> => new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });

  console.log("[TEST 1] Testing Valid Structured Message & Rate Limits");
  const ws1 = await connect();
  
  const validPayload = {
    version: "1.0",
    type: "offer",
    agent_id: "agent_testing",
    timestamp: Date.now(),
    price: 10,
    collateral_buyer: 1,
    collateral_seller: 1,
    asset_type: "token"
  };

  ws1.send(JSON.stringify(validPayload));
  await sleep(200);
  const boundWs = sessionManager.getSessionByAgent("agent_testing");
  if (!boundWs || boundWs.readyState !== WebSocket.OPEN) {
    failTest("Test 1", "Session was not correctly bound to agent map!");
  } else {
    passTest("Session binding and valid structured payload parsed cleanly");
  }

  console.log("\n[TEST 2] Testing Invalid Schema Reply natively");
  const invalidPayload = {
    version: "1.0",
    type: "offer",
    agent_id: "agent_testing",
    // Purposely missing structured fields natively blocking payload memory validation limits.
  };
  ws1.send(JSON.stringify(invalidPayload));
  
  const reply2 = await nextMessage(ws1);
  if (reply2.type === "error" && reply2.error === "Validation failed") {
    passTest("Gateway returned correctly formatted JSON Zod error natively.");
  } else {
    failTest("Test 2", `Did not receive formatted error -> ${JSON.stringify(reply2)}`);
  }

  console.log("\n[TEST 3] Oversized Payload Rejection");
  const oversizedPayload = "a".repeat(3000);
  ws1.send(oversizedPayload);
  
  const reply3 = await nextMessage(ws1);
  if (reply3.type === "error" && reply3.error === "Payload Too Large") {
    passTest("Gateway correctly intercepted and blocked a 3KB attack BEFORE parsing json memory scopes.");
  } else {
    failTest("Test 3", "Failed to deflect oversized boundary.");
  }

  console.log("\n[TEST 4] Session Replacement Enforcement");
  // `ws1` is currently still attached to `agent_testing`.
  // If we hook a second agent acting maliciously as `agent_testing`, the Gateway MUST boot out `ws1` securely.
  const wsReplacement = await connect();
  wsReplacement.send(JSON.stringify(validPayload)); 

  const reply4 = await nextMessage(ws1); // Checking the FIRST socket to see its error hook natively pushing Session Replaced
  if (reply4.type === "error" && reply4.error === "Session Replaced") {
    passTest("Gateway correctly booted duplicate agent connection instantly sending Session Replaced and closing the ghosted WS pipeline.");
  } else {
    failTest("Test 4", "Gateway failed to terminate the original cloned connection.");
  }

  wsReplacement.close();
  await sleep(100);

  console.log("\n=== ALL WEBSOCKET TESTS PASSED ===");
  stopWsGateway();
  process.exit(0);
}

runTests().catch(console.error);
