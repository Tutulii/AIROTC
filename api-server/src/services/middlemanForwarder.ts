/**
 * Middleman Forwarder — Bridges API Server → Middleman Agent
 * 
 * PRODUCTION: All requests are HMAC-signed to prevent unauthorized access.
 * The Middleman verifies the signature before processing.
 * 
 * Uses /v1/deals/create-matched for the "Quick Buy" action.
 * All calls are non-blocking (fire-and-forget) to avoid slowing API responses.
 */

import { signRequest } from './hmacSigner';

const MIDDLEMAN_URL = process.env.MIDDLEMAN_URL || 'http://localhost:8080';

function isStrictPerOpaqueBridgeEnabled(): boolean {
    const raw = process.env.PER_STRICT_OPAQUE_MODE;
    if (raw === undefined) return true;
    return raw !== 'false';
}

function buildSignedHeaders(method: string, path: string, body: string): Record<string, string> {
    const { signature, timestamp } = signRequest(method, path, body);
    return {
        'Content-Type': 'application/json',
        'X-Bridge-Signature': signature,
        'X-Bridge-Timestamp': timestamp,
    };
}

export const middlemanForwarder = {

    async isHealthy(): Promise<boolean> {
        try {
            const res = await fetch(`${MIDDLEMAN_URL}/v1/agent/stats`, {
                signal: AbortSignal.timeout(3000),
            });
            return res.ok;
        } catch {
            return false;
        }
    },

    /**
     * Forward a matched deal to the Middleman's pipeline.
     * Both buyer AND seller are paired in one ticket.
     */
    async forwardOfferAccepted(params: {
        ticketId: string;
        buyerWallet: string;
        sellerWallet: string;
        buyerSettlementWallet?: string | null;
        sellerSettlementWallet?: string | null;
        buyerRewardWallet?: string | null;
        sellerRewardWallet?: string | null;
        buyerFundingWallet?: string | null;
        sellerFundingWallet?: string | null;
        asset: string;
        price: number | null;
        amount: number;
        collateral: number | null;
        tokenMint?: string | null;
        rollupMode?: string | null;
    }): Promise<{ success: boolean; middlemanTicketId?: string; error?: string }> {
        try {
            const path = '/v1/deals/create-matched';
            const redactPrivateTerms =
                params.rollupMode === 'PER' && isStrictPerOpaqueBridgeEnabled();
            const body = JSON.stringify({
                buyerWallet: params.buyerWallet,
                sellerWallet: params.sellerWallet,
                asset: params.asset,
                price: redactPrivateTerms ? null : String(params.price ?? 0),
                amount: String(params.amount),
                collateral: redactPrivateTerms ? null : String(params.collateral ?? 0),
                externalTicketId: params.ticketId,
                tokenMint: params.tokenMint || null,
                rollupMode: params.rollupMode || 'ER',
                buyerSettlementWallet: params.buyerSettlementWallet || null,
                sellerSettlementWallet: params.sellerSettlementWallet || null,
                buyerRewardWallet: params.buyerRewardWallet || null,
                sellerRewardWallet: params.sellerRewardWallet || null,
                buyerFundingWallet: params.buyerFundingWallet || null,
                sellerFundingWallet: params.sellerFundingWallet || null,
            });

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
                const errBody = await res.text();
                return { success: false, error: errBody };
            }

            const data = await res.json() as { ticketId?: string; status?: string };
            return {
                success: true,
                middlemanTicketId: data.ticketId,
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    /**
     * Forward a negotiation message to the Middleman's brain.
     * Returns the brain's decision (action, phase, reasoning).
     */
    async forwardMessage(params: {
        ticketId: string;
        sender: string;
        content: string;
    }): Promise<{ success: boolean; brain?: any; error?: string }> {
        try {
            const path = `/v1/deals/${params.ticketId}/message`;
            const body = JSON.stringify({
                sender: params.sender,
                content: params.content,
            });

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(15000), // Brain analysis can take time
            });

            if (!res.ok) {
                const errBody = await res.text();
                return { success: false, error: errBody };
            }

            const data = await res.json();
            return { success: true, brain: data };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    /**
     * Get deal status from the Middleman.
     */
    async getDealStatus(ticketId: string): Promise<{ success: boolean; deal?: any; error?: string }> {
        try {
            const path = `/v1/deals/${ticketId}/status`;
            const { signature, timestamp } = signRequest('GET', path, '');

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'GET',
                headers: {
                    'X-Bridge-Signature': signature,
                    'X-Bridge-Timestamp': timestamp,
                },
                signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
                return { success: false, error: `Status ${res.status}` };
            }

            const data = await res.json();
            return { success: true, deal: data };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },
};
