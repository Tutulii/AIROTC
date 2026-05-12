import crypto from "crypto";
import { eventBus } from "../services/eventBus";
import { Message } from "../types/message";
import { ticketStore } from "../state/ticketStore";
import { assertDemoRuntimeListenerAllowed } from "../utils/demoMode";

let messageInterval: NodeJS.Timeout | null = null;
const simulatedMessages = [
  "I can do 5 SOL for this.",
  "Let's make the collateral 1 SOL to be safe.",
  "price 4.5 and we have a deal",
  "ok, agreed.",
  "both deposit 2",
  "confirm"
];

export function startMessageListener(intervalMs: number = 5000): void {
  assertDemoRuntimeListenerAllowed("message_listener");
  if (messageInterval) return;

  messageInterval = setInterval(() => {
    simulateIncomingMessage();
  }, intervalMs);
}

export function stopMessageListener(): void {
  if (messageInterval) {
    clearInterval(messageInterval);
    messageInterval = null;
  }
}

async function simulateIncomingMessage(): Promise<void> {
  const allTickets = await ticketStore.listTickets();
  const activeTickets = allTickets.filter(t => t.status === "active");
  if (activeTickets.length === 0) return; // No active tickets to chat in

  const randomTicket = activeTickets[Math.floor(Math.random() * activeTickets.length)];
  const randomMsgContent = simulatedMessages[Math.floor(Math.random() * simulatedMessages.length)];
  const isBuyer = Math.random() > 0.5;

  const message: Message = {
    message_id: `msg_${crypto.randomBytes(4).toString("hex")}`,
    ticket_id: randomTicket.ticket_id,
    sender: isBuyer ? randomTicket.buyer : randomTicket.seller,
    content: randomMsgContent,
    timestamp: new Date().toISOString(),
  };

  eventBus.publish("message_received", message);
}
