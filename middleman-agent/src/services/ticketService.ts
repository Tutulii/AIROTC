import crypto from "crypto";
import { AcceptanceEvent, Ticket } from "../types/ticket";
import { ticketStore } from "../state/ticketStore";
import { eventBus } from "./eventBus";

export function createTicketFromAcceptance(event: AcceptanceEvent): Ticket {
  const ticket: Ticket = {
    ticket_id: `tkt_${crypto.randomBytes(6).toString("hex")}`,
    offer_id: event.offer_id,
    buyer: event.buyer,
    seller: event.seller,
    status: "active",
    created_at: new Date().toISOString(),
  };

  // Store in continuous memory
  ticketStore.createTicket(ticket);

  // Publish strongly-typed event
  eventBus.publish("ticket_created", ticket);

  return ticket;
}
