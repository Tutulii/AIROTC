import crypto from "crypto";
import { AcceptanceEvent } from "../types/ticket";
import { createTicketFromAcceptance } from "../services/ticketService";
import { assertDemoRuntimeListenerAllowed } from "../utils/demoMode";

let acceptanceInterval: NodeJS.Timeout | null = null;

export function startAcceptanceListener(intervalMs: number = 12000): void {
  assertDemoRuntimeListenerAllowed("acceptance_listener");
  if (acceptanceInterval) return;

  // Simulate listening to an off-chain messaging layer or blockchain acceptance events
  acceptanceInterval = setInterval(() => {
    simulateAcceptanceDetection();
  }, intervalMs);
}

export function stopAcceptanceListener(): void {
  if (acceptanceInterval) {
    clearInterval(acceptanceInterval);
    acceptanceInterval = null;
  }
}

function simulateAcceptanceDetection(): void {
  const event: AcceptanceEvent = {
    offer_id: crypto.randomUUID(),
    buyer: `wallet_buyer_${crypto.randomBytes(2).toString("hex")}`,
    seller: `wallet_seller_${crypto.randomBytes(2).toString("hex")}`,
    timestamp: new Date().toISOString(),
  };

  createTicketFromAcceptance(event);
}
