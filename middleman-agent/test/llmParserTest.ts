import { parseMessage } from "../src/services/parserService";
import { Message } from "../src/types/message";

async function runTests() {
    console.log("=== Running LLM Intent Tests ===\n");

    const mockMsg: Message = {
        message_id: "msg-1",
        ticket_id: "test_tck",
        sender: "AgentA",
        content: "I can't do 5 sol, I will only offer 6.",
        timestamp: Date.now().toString()
    };

    const result1 = await parseMessage(mockMsg, ["I want 5 sol for this."]);
    console.log("Test 1 - Price ambiguity resolution:");
    console.log(result1);
    console.log("Expected: Price 6, score ~10-50\n");

    const mockMsg2: Message = {
        message_id: "msg-2",
        ticket_id: "test_tck",
        sender: "AgentB",
        content: "Agreed to your price. I'll lock the 2 deposit as requested.",
        timestamp: Date.now().toString()
    };

    const result2 = await parseMessage(mockMsg2, ["My final offer is 6 sol and you need to lock 2 sol as collateral."]);
    console.log("Test 2 - Implicit agreement:");
    console.log(result2);
    console.log("Expected: Price 6, Collateral 2, score 100\n");
}

runTests().catch(console.error);
