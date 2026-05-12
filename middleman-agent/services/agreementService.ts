import { ticketStore } from "../store/ticketStore";
import { eventBus } from "../src/services/eventBus";
import { parseMessage } from "./parserService";
import { negotiationStore } from "../src/state/negotiationStore";
import { walletRegistry } from "../src/state/walletRegistry";

export interface AgreementResult {
    ticket_id: string;
    price: number;
    collateral_buyer: number;
    collateral_seller: number;
    confidence: number;
    message_count: number;
}

function logAnalysis(ticketId: string, confidence: number, status: string) {
    console.log(JSON.stringify({
        event: "agreement_analysis",
        ticket_id: ticketId,
        confidence,
        status
    }));
}

export async function detectAgreement(ticketId: string): Promise<AgreementResult | null> {
    const ticket = await ticketStore.getTicket(ticketId);
    if (!ticket) {
        return null;
    }

    const allNegotiations = await negotiationStore.getNegotiationHistory(ticketId);
    const history = allNegotiations.slice(-10);

    // Ensure messages from BOTH parties exist
    const participants = new Set<string>();
    for (const step of history) {
        participants.add(step.proposedBy);
    }
    if (participants.size < 2) {
        return null;
    }

    let buyerPrice: number | null = null;
    let sellerPrice: number | null = null;
    let buyerProposedBuyerCol: number | null = null;
    let buyerProposedSellerCol: number | null = null;
    let sellerProposedBuyerCol: number | null = null;
    let sellerProposedSellerCol: number | null = null;

    let buyerStrongSignals = 0;
    let sellerStrongSignals = 0;

    // Resolve wallet pubkeys → internal UUIDs for comparison
    // negotiation.proposedBy stores UUIDs (set by index.ts:273), but ticket.buyer/seller are wallet pubkeys
    const buyerAgent = await walletRegistry.getOrCreateAgent(ticket.buyer);
    const sellerAgent = await walletRegistry.getOrCreateAgent(ticket.seller);
    const buyerId = buyerAgent.id;
    const sellerId = sellerAgent.id;

    // Track convergence parsing directly from negotiation history
    for (const step of history) {
        const isBuyer = step.proposedBy === buyerId;
        const isSeller = step.proposedBy === sellerId;

        if (isBuyer) {
            if (step.proposedPrice !== null) buyerPrice = step.proposedPrice;
            if (step.collateralBuyer !== null) buyerProposedBuyerCol = step.collateralBuyer;
            if (step.collateralSeller !== null) buyerProposedSellerCol = step.collateralSeller;
            if (step.agreementScore >= 40) buyerStrongSignals++;
        } else if (isSeller) {
            if (step.proposedPrice !== null) sellerPrice = step.proposedPrice;
            if (step.collateralBuyer !== null) sellerProposedBuyerCol = step.collateralBuyer;
            if (step.collateralSeller !== null) sellerProposedSellerCol = step.collateralSeller;
            if (step.agreementScore >= 40) sellerStrongSignals++;
        }
    }

    // CONVERGENCE CHECK (Critical)

    // 1. Check if both sides converged on price (if both mentioned one)
    if (buyerPrice !== null && sellerPrice !== null && buyerPrice !== sellerPrice) {
        logAnalysis(ticketId, 0, "rejected_price_mismatch");
        return null;
    }

    const finalPrice = sellerPrice ?? buyerPrice;
    if (finalPrice === null) {
        logAnalysis(ticketId, 0, "rejected_missing_price");
        return null;
    }

    // 2. Resolve collateral properly
    // Check if parties explicitly disagreed on collateral values
    if (buyerProposedBuyerCol !== null && sellerProposedBuyerCol !== null && buyerProposedBuyerCol !== sellerProposedBuyerCol) {
        logAnalysis(ticketId, 0, "rejected_collateral_mismatch");
        return null;
    }
    if (buyerProposedSellerCol !== null && sellerProposedSellerCol !== null && buyerProposedSellerCol !== sellerProposedSellerCol) {
        logAnalysis(ticketId, 0, "rejected_collateral_mismatch");
        return null;
    }

    // Fall back to whoever proposed it last
    const finalBuyerCol = sellerProposedBuyerCol ?? buyerProposedBuyerCol;
    const finalSellerCol = sellerProposedSellerCol ?? buyerProposedSellerCol;

    if (finalBuyerCol === null || finalSellerCol === null) {
        logAnalysis(ticketId, 0, "rejected_missing_collateral");
        return null;
    }

    // Pass the full conversation to parser to get a smart, context-aware agreement score
    // The parserService already boosts the score if it sees context from the array of messages
    const allMessageTexts = history.map((h: any) => h.rawText);
    const globalContextParsed = parseMessage(allMessageTexts);
    let confidence = globalContextParsed.agreement_score;

    // Both parties must show some intent/participation in agreeing
    if (buyerStrongSignals === 0 || sellerStrongSignals === 0) {
        confidence -= 30; // penalize if one party never explicitly signaled
    } else {
        confidence += 10; // reward true mutual explicit agreement
    }

    // Message density logic
    const densityPoints = Math.min(15, history.length * 3);
    confidence += densityPoints;

    confidence = Math.min(100, Math.round(confidence));

    // FINAL DECISION — 50 threshold for direct OTC (explicit price + collateral + agreement)
    if (confidence >= 50) {
        const result: AgreementResult = {
            ticket_id: ticketId,
            price: finalPrice,
            collateral_buyer: finalBuyerCol,
            collateral_seller: finalSellerCol,
            confidence,
            message_count: history.length
        };

        logAnalysis(ticketId, confidence, "confirmed");
        return result;
    }

    logAnalysis(ticketId, confidence, "rejected_low_confidence");
    return null;
}

export async function runAgreementTests() {
    await ticketStore.createTicket({
        id: "T1", buyer: "B", seller: "S"
    } as any);
    await ticketStore.createTicket({
        id: "T2", buyer: "B", seller: "S"
    } as any);
    await ticketStore.createTicket({
        id: "T3", buyer: "B", seller: "S"
    } as any);
    await ticketStore.createTicket({
        id: "T4", buyer: "B", seller: "S"
    } as any);

    const ts = new Date().toISOString();

    // Case 1: clear agreement
    await negotiationStore.addNegotiationStep("T1", { price: 5, collateral_buyer: 2, collateral_seller: 2, agreement_signal: true } as any, "B", "agreed, deal at 5 sol, both deposit 2 sol");
    await negotiationStore.addNegotiationStep("T1", { agreement_signal: true } as any, "S", "confirmed! deal is good");

    // Case 2: disagreement (price gap explicitly mismatched)
    await negotiationStore.addNegotiationStep("T2", { price: 5, collateral_buyer: 1, collateral_seller: 1, agreement_signal: false } as any, "B", "deal at 5 sol, both deposit 1");
    await negotiationStore.addNegotiationStep("T2", { price: 10, collateral_buyer: 1, collateral_seller: 1, agreement_signal: true } as any, "S", "no, price 10 sol, both deposit 1. confirmed.");

    // Case 3: partial agreement (missing collateral)
    await negotiationStore.addNegotiationStep("T3", { price: 3, agreement_signal: false } as any, "B", "let's do 3 sol");
    await negotiationStore.addNegotiationStep("T3", { price: 3, agreement_signal: true } as any, "S", "agreed deal at 3 sol confirmed");

    // Case 4: collateral mismatch
    await negotiationStore.addNegotiationStep("T4", { price: 5, collateral_buyer: 2, collateral_seller: 2, agreement_signal: false } as any, "B", "deal at 5 sol, both deposit 2");
    await negotiationStore.addNegotiationStep("T4", { price: 5, collateral_buyer: 3, collateral_seller: 3, agreement_signal: true } as any, "S", "deal at 5 sol, both deposit 3. confirmed.");


    console.log("=== Running Case 1: Clear Agreement ===");
    console.log(await detectAgreement("T1"));

    console.log("=== Running Case 2: Disagreement ===");
    console.log(await detectAgreement("T2"));

    console.log("=== Running Case 3: Partial Agreement ===");
    console.log(await detectAgreement("T3"));

    console.log("=== Running Case 4: Collateral Mismatch ===");
    console.log(await detectAgreement("T4"));
}

if (require.main === module) {
    runAgreementTests().catch(console.error);
}
