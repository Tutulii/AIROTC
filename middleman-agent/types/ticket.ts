export interface Ticket {
  id: string;
  buyer: string;
  seller: string;

  last_proposed_price?: number;
  last_collateral_buyer?: number;
  last_collateral_seller?: number;

  agreement_score?: number;

  negotiation_history?: Array<{
    message: string;
    parsed: {
      price?: number;
      collateral_buyer?: number;
      collateral_seller?: number;
      agreement_score?: number;
    };
    sender: string;
    timestamp: number;
  }>;
}
