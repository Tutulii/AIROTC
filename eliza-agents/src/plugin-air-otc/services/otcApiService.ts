/**
 * OTC API Service — HTTP client for AIR OTC Middleman REST API
 * 
 * Shared by all ElizaOS agent actions. Provides typed methods for
 * every platform endpoint with HMAC bridge authentication.
 */

import crypto from "crypto";

export interface Offer {
  id: string;
  asset: string;
  price: number;
  amount: number;
  mode: "buy" | "sell";
  collateral: number;
  status: string;
  creator: { wallet: string };
  rollupMode?: string;
}

export interface Ticket {
  id: string;
  buyer: string;
  seller: string;
  status: string;
  rollupMode?: string;
}

export interface DealStatus {
  ticketId: string;
  phase: string;
  buyer: string;
  seller: string;
  escrow_pda: string | null;
  payment_locked: boolean;
  terms: { price?: number; collateral_buyer?: number; collateral_seller?: number } | null;
}

export interface BrainResponse {
  response: string;
  action: string;
  phase: string;
  reasoning?: string;
}

export class OtcApiService {
  private baseUrl: string;
  private bridgeSecret: string;
  private agentName: string;

  constructor(baseUrl: string, agentName: string, bridgeSecret: string = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.agentName = agentName;
    this.bridgeSecret = bridgeSecret;
  }

  private signBridge(method: string, path: string, bodyStr: string): { signature: string; timestamp: string } {
    const timestamp = String(Date.now());
    const payload = `${timestamp}:${method.toUpperCase()}:${path}:${bodyStr}`;
    const signature = crypto.createHmac("sha256", this.bridgeSecret).update(payload).digest("hex");
    return { signature, timestamp };
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const bodyStr = body ? JSON.stringify(body) : "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (path.startsWith("/v1/deals/") && this.bridgeSecret) {
      const { signature, timestamp } = this.signBridge(method, path, bodyStr);
      headers["X-Bridge-Signature"] = signature;
      headers["X-Bridge-Timestamp"] = timestamp;
    }

    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
    if (body) options.body = bodyStr;

    const res = await fetch(url, options);
    const data = await res.json() as T;

    if (!res.ok) {
      const errMsg = (data as any)?.error || (data as any)?.message || res.statusText;
      throw new Error(`API ${method} ${path} failed (${res.status}): ${errMsg}`);
    }
    return data;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/agent/stats`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  }

  async register(wallet: string): Promise<{ created: boolean; data: { id: string; wallet: string } }> {
    return this.request("POST", "/v1/agents/register", { wallet });
  }

  async listOffers(filters?: { asset?: string; mode?: string }): Promise<{ success: boolean; data: Offer[] }> {
    const params = new URLSearchParams();
    if (filters?.asset) params.set("asset", filters.asset);
    if (filters?.mode) params.set("mode", filters.mode);
    const qs = params.toString();
    return this.request("GET", `/v1/offers${qs ? `?${qs}` : ""}`);
  }

  async createOffer(params: {
    asset: string; price: number; amount: number; mode: "buy" | "sell";
    collateral: number; wallet: string; rollupMode?: string; settlementWallet?: string;
  }): Promise<{ success: boolean; offerId: string; data: Offer }> {
    return this.request("POST", "/v1/offers", {
      asset: params.asset, price: params.price, amount: params.amount,
      mode: params.mode, collateral: params.collateral,
      publicKey: params.wallet, rollupMode: params.rollupMode || "ER",
      settlementWallet: params.settlementWallet,
    });
  }

  async acceptOffer(offerId: string, wallet: string, settlementWallet?: string): Promise<{ success: boolean; ticket: Ticket }> {
    return this.request("POST", `/v1/offers/${offerId}/accept`, {
      publicKey: wallet, wallet, settlementWallet,
    });
  }

  async getDealStatus(ticketId: string): Promise<DealStatus> {
    return this.request("GET", `/v1/deals/${ticketId}/status`);
  }

  async sendMessage(ticketId: string, sender: string, content: string): Promise<BrainResponse> {
    return this.request("POST", `/v1/deals/${ticketId}/message`, { sender, content });
  }
}
