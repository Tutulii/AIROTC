import { eventBus } from "../services/eventBus";
import { OfferDetectedEvent, OfferType } from "../types/events";
import crypto from "crypto";
import { assertDemoRuntimeListenerAllowed } from "../utils/demoMode";

let listenerInterval: NodeJS.Timeout | null = null;

export function startOfferListener(intervalMs: number = 8000): void {
  assertDemoRuntimeListenerAllowed("offer_listener");
  if (listenerInterval) return;

  // Simulate connecting to a public offer stream
  listenerInterval = setInterval(() => {
    simulateOfferDetection();
  }, intervalMs);
}

export function stopOfferListener(): void {
  if (listenerInterval) {
    clearInterval(listenerInterval);
    listenerInterval = null;
  }
}

function simulateOfferDetection(): void {
  // Simulate random offer data
  const types: OfferType[] = ["buy", "sell"];
  const randomType = types[Math.floor(Math.random() * types.length)];
  const randomSol = (Math.random() * 10 + 0.1).toFixed(2);
  
  const rawOffer = {
    offer_id: crypto.randomUUID(),
    type: randomType,
    creator: `wallet_${crypto.randomBytes(4).toString("hex")}`,
    content: randomType === "sell" 
      ? `Selling AI model dataset for ${randomSol} SOL`
      : `Buying computation for ${randomSol} SOL`,
  };

  const event: OfferDetectedEvent = {
    offer_id: rawOffer.offer_id,
    type: rawOffer.type as OfferType,
    creator: rawOffer.creator,
    content: rawOffer.content,
    timestamp: new Date().toISOString(),
  };

  eventBus.publish("offer_detected", event);
}
