export type TicketStatus = "active" | "completed" | "disputed" | "cancelled";
export type RollupMode = "NONE" | "ER" | "PER";

export interface AgreedTerms {
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
}

export interface Ticket {
  ticket_id: string;
  offer_id: string;
  buyer: string;
  seller: string;
  status: TicketStatus;
  rollup_mode?: RollupMode;
  tokenMint?: string;
  decimals?: number;
  created_at: string;
  deal_phase?: string;
  agreed_terms?: AgreedTerms;
}

export interface AcceptanceEvent {
  offer_id: string;
  buyer: string;
  seller: string;
  timestamp: string;
}
