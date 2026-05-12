import { validateAgentMessage, AgentMessageSchema } from "../src/protocol/agentProtocol";

function failTest(message: string, error?: any) {
  console.error(`❌ FAILED: ${message}`, error || "");
  process.exit(1);
}

function passTest(message: string) {
  console.log(`✅ PASSED: ${message}`);
}

async function runProtocolTests() {
  console.log("\n=== 📡 AGENT COMMUNICATION PROTOCOL TESTS ===\n");

  // TEST 1: Valid Offer
  console.log("[TEST 1] Testing Valid Offer Structure");
  try {
    const validOffer = {
      version: "1.0",
      type: "offer",
      agent_id: "agent_8x99A",
      timestamp: Date.now(),
      price: 15.5,
      collateral_buyer: 5.0,
      collateral_seller: 0,
      asset_type: "solana_token",
      asset_description: "Unique token negotiated OTC",
    };
    const parsed = validateAgentMessage(validOffer);
    passTest("Offer parsed cleanly with types structurally asserted.");
  } catch (e: any) {
    failTest("Valid offer threw an error", e.message);
  }

  // TEST 2: Valid Unstructured Payload
  console.log("\n[TEST 2] Testing Unstructured Reject Signal");
  try {
    const validReject = {
      version: "1.0",
      type: "reject",
      ticket_id: "ticket_A99831",
      agent_id: "agent_444xOP",
      timestamp: Date.now(),
      content: "Cannot accept your last counter, price too high."
    };
    const parsed = validateAgentMessage(validReject);
    passTest("Unstructured reject trace parsed successfully.");
  } catch (e: any) {
    failTest("Unstructured payload rejected unexpectedly", e.message);
  }

  // TEST 3: Reject Missing Required Keys
  console.log("\n[TEST 3] Testing Missing Ticket ID for Cancel Signal");
  try {
    const missingTicket = {
      version: "1.0",
      type: "cancel",
      agent_id: "agent_123",
      timestamp: Date.now(),
      content: "Aborting"
    };
    validateAgentMessage(missingTicket);
    failTest("Missing ticket_id allowed for unstructured schema!");
  } catch (e: any) {
    if (e.message.includes("ticket_id")) {
      passTest(`Rejected missing ticket natively -> ${e.message}`);
    } else {
      failTest("Did not complain about ticket_id", e.message);
    }
  }

  // TEST 4: Reject Negative Prices
  console.log("\n[TEST 4] Testing Negative Bound Overrides");
  try {
    const maliciousPrice = {
      version: "1.0",
      type: "accept",
      ticket_id: "t_10x",
      agent_id: "agent_A",
      timestamp: Date.now(),
      price: -10,
      collateral_buyer: 5.0,
      collateral_seller: 5.0,
      asset_type: "token",
    };
    validateAgentMessage(maliciousPrice);
    failTest("Allowed negative price constraint breach!");
  } catch (e: any) {
    if (e.message.includes("price: Number must be greater than 0")) {
      passTest(`Rejected negative price constraint -> ${e.message}`);
    } else {
      failTest("Did not catch price bound error", e.message);
    }
  }

  // TEST 5: Reject Arbitrary JSON Types
  console.log("\n[TEST 5] Unknown Instruction Types");
  try {
    const fakeType = {
      version: "1.0",
      type: "hack_system",
      ticket_id: "t_10x",
      agent_id: "agent_A",
      timestamp: Date.now(),
      content: "Hacking code payload"
    };
    validateAgentMessage(fakeType);
    failTest("Fake type instruction approved through bounds");
  } catch (e: any) {
    if (e.message.includes("Invalid discriminator")) {
      passTest(`Vetoed rogue type natively -> ${e.message}`);
    } else {
      failTest("Discriminant failed to capture unknown type", e.message);
    }
  }

  // TEST 6: Reject Injection strings in numeric types
  console.log("\n[TEST 6] Type Injection Constraints (String in Number)");
  try {
    const strInject = {
        version: "1.0",
        type: "offer",
        agent_id: "agent_b",
        timestamp: Date.now(),
        price: "100", // Invalid TS, String typed
        collateral_buyer: 0,
        collateral_seller: 0,
        asset_type: "wsol"
    };
    validateAgentMessage(strInject);
    failTest("Implicit casting enabled! System bypass possible");
  } catch (e: any) {
    if (e.message.includes("Expected number, received string")) {
       passTest(`Strict casting rules applied -> ${e.message}`);
    } else {
       failTest("Failed to catch injection", e.message);
    }
  }

  // TEST 7: Metadata keys exceeding safe limit
  console.log("\n[TEST 7] Metadata Payload DDoS Bloat Limits");
  try {
    const bloatedMeta = {
      version: "1.0",
      type: "message",
      ticket_id: "100",
      agent_id: "agent",
      timestamp: Date.now(),
      content: "Hello",
      metadata: {
        a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" // 6 keys, limit is 5
      }
    };
    validateAgentMessage(bloatedMeta);
    failTest("Metadata allowed more than 5 elements.");
  } catch (e: any) {
    if (e.message.includes("Metadata cannot exceed 5 keys")) {
      passTest(`Rebuffed bloated metadata correctly -> ${e.message}`);
    } else {
      failTest("Metadata bloat uncaught", e.message);
    }
  }

  // TEST 8: Strict No Overflow Properties
  console.log("\n[TEST 8] Restricting JSON Object Poisoning");
  try {
    const poisonProps = {
      version: "1.0",
      type: "message",
      ticket_id: "123",
      agent_id: "agentX",
      timestamp: 1234567,
      content: "Hey there!",
      bonus_field: "Injecting memory via undeclared prop",
      exploit_buffer: [1,2,3,4,5,6]
    };
    validateAgentMessage(poisonProps);
    failTest("JSON Payload accepted extraneous undeclared properties!");
  } catch (e: any) {
    if (e.message.includes("Unrecognized key")) {
       passTest(`Object strictness mapped flawlessly -> ${e.message}`);
    } else {
       failTest("Undeclared args slipped past strict()", e.message);
    }
  }

  console.log("\n=== ALL BOUNDARY TESTS PASSED SECURELY ===");
}

runProtocolTests().catch(console.error);
