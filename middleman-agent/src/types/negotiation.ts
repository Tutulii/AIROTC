export interface NegotiationState {
  ticket_id: string;
  proposed_price?: string;
  collateral_buyer?: string;
  collateral_seller?: string;
  last_updated: string;
  agreement_detected: boolean;
  // Brain-required fields for auto-agreement detection
  both_parties_present?: boolean;
  price_converged?: boolean;
  message_count?: number;
  senders?: Set<string>;
  last_price_by_sender?: Record<string, string>;
  agreement_signals_count?: number;
}

export interface ParsedSignals {
  price: number | null;
  collateral_buyer: number | null;
  collateral_seller: number | null;
  agreement_signal?: boolean; // legacy
  agreement_score?: number; // current
}
