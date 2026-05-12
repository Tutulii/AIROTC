import axios from "axios";

const API_URL = "http://localhost:3000"; // Update if your API is on a different port

async function runBuyer() {
    console.log("🟢 [BUYER] Waking up. Looking for tokens to buy...");
    
    // 1. Create a Buy Ticket
    const ticketPayload = {
        type: "buy",
        asset: "SOL",
        amount: 100,
        maxPrice: 150, // Willing to pay up to 150 USDC per SOL
        agentId: "buyer-agent-001"
    };

    try {
        console.log("🟢 [BUYER] Submitting Buy Ticket...");
        const ticketRes = await axios.post(`${API_URL}/api/tickets`, ticketPayload);
        const ticketId = ticketRes.data.id;
        console.log(`🟢 [BUYER] Ticket created: ${ticketId}. Waiting for matches...`);

        // 2. Poll for Matches / Active Sessions
        let sessionFound = false;
        while (!sessionFound) {
            await new Promise(r => setTimeout(r, 2000));
            const statusRes = await axios.get(`${API_URL}/api/tickets/${ticketId}/status`);
            
            if (statusRes.data.status === "negotiating" && statusRes.data.sessionId) {
                console.log(`🟢 [BUYER] Match found! Joined Session: ${statusRes.data.sessionId}`);
                sessionFound = true;
                
                // 3. Propose a Negotiation Price on MagicBlock ER
                console.log("🟢 [BUYER] Sending negotiation proposal on Ephemeral Rollup...");
                const start = Date.now();
                await axios.post(`${API_URL}/api/sessions/${statusRes.data.sessionId}/negotiate`, {
                    agentId: "buyer-agent-001",
                    proposedPrice: 145 // Propose 145 USDC
                });
                console.log(`🟢 [BUYER] Proposal processed in ${Date.now() - start}ms!`);
            }
        }
    } catch (error: any) {
        console.error("🔴 [BUYER] Error:", error.response?.data || error.message);
    }
}

runBuyer();
