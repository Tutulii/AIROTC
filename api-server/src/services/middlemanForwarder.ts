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
        sportPositionVaults?: {
            buyerPositionVaultPda?: string | null;
            sellerPositionVaultPda?: string | null;
            buyerPositionId?: string | null;
            sellerPositionId?: string | null;
            stakeLamports?: string | null;
            fillId?: string | null;
            fillLamports?: string | null;
            vaultVersion?: string | null;
        } | null;
    }): Promise<{
        success: boolean;
        middlemanTicketId?: string;
        phase?: string;
        dealPda?: string | null;
        tx?: string | null;
        status?: string;
        depositInstructions?: {
            escrowPda: string;
            buyer: {
                wallet: string;
                stake?: number;
                payment?: number;
                collateral?: number;
                protocolDustLamports?: number;
                total: number;
            };
            seller: {
                wallet: string;
                stake?: number;
                collateral?: number;
                total: number;
            };
        } | null;
        error?: string;
    }> {
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
                sportPositionVaults: params.sportPositionVaults || null,
            });

            const timeoutMs = params.rollupMode === 'SPORT' ? 60_000 : 5_000;
            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (!res.ok) {
                const errBody = await res.text();
                return { success: false, error: errBody };
            }

            const data = await res.json() as {
                ticketId?: string;
                status?: string;
                phase?: string;
                dealPda?: string | null;
                tx?: string | null;
                depositInstructions?: {
                    escrowPda: string;
                    buyer: {
                        wallet: string;
                        stake?: number;
                        payment?: number;
                        collateral?: number;
                        protocolDustLamports?: number;
                        total: number;
                    };
                    seller: {
                        wallet: string;
                        stake?: number;
                        collateral?: number;
                        total: number;
                    };
                } | null;
            };
            const result: {
                success: boolean;
                middlemanTicketId?: string;
                phase?: string;
                dealPda?: string | null;
                tx?: string | null;
                status?: string;
                depositInstructions?: typeof data.depositInstructions;
            } = {
                success: true,
                middlemanTicketId: data.ticketId,
            };
            if (data.phase) result.phase = data.phase;
            if (Object.prototype.hasOwnProperty.call(data, 'dealPda')) result.dealPda = data.dealPda || null;
            if (Object.prototype.hasOwnProperty.call(data, 'tx')) result.tx = data.tx || null;
            if (data.status) result.status = data.status;
            if (Object.prototype.hasOwnProperty.call(data, 'depositInstructions')) {
                result.depositInstructions = data.depositInstructions || null;
            }
            return result;
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

    /**
     * Forward a TxLINE SPORT settlement decision to the escrow owner.
     * The middleman verifies the ticket is SPORT and funded before executing.
     */
    async forwardSportSettlement(params: {
        ticketId: string;
        settlementAction: 'release_to_maker' | 'refund_to_taker' | 'release_to_seller' | 'release_to_buyer' | 'void_refund';
        matchId?: string | null;
        fixtureId?: string | null;
        outcomeWinner?: string | null;
        winnerWallet?: string | null;
    }): Promise<{
        success: boolean;
        tx?: string;
        onChainAction?: string;
        status?: string;
        error?: string;
        raw?: any;
    }> {
        try {
            const path = `/v1/deals/${params.ticketId}/sport-settle`;
            const body = JSON.stringify({
                settlementAction: params.settlementAction,
                matchId: params.matchId || null,
                fixtureId: params.fixtureId || null,
                outcomeWinner: params.outcomeWinner || null,
                winnerWallet: params.winnerWallet || null,
            });

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(60000),
            });

            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = { raw: text };
            }

            if (!res.ok || !data?.success) {
                return {
                    success: false,
                    error: data?.error || `Status ${res.status}`,
                    raw: data,
                };
            }

            return {
                success: true,
                tx: data.tx,
                onChainAction: data.onChainAction,
                status: data.status,
                raw: data,
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    async forwardExpiredSportPositionRefund(params: {
        positionId: string;
        ownerWallet: string;
        vaultPda?: string | null;
        closeIfNoCommittedStake?: boolean;
    }): Promise<{
        success: boolean;
        tx?: string;
        closeTx?: string;
        refundedLamports?: string;
        closed?: boolean;
        error?: string;
        raw?: any;
    }> {
        try {
            const path = `/v1/sport/positions/${encodeURIComponent(params.positionId)}/refund-expired`;
            const body = JSON.stringify({
                ownerWallet: params.ownerWallet,
                vaultPda: params.vaultPda || null,
                closeIfNoCommittedStake: params.closeIfNoCommittedStake !== false,
            });

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(60000),
            });

            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = { raw: text };
            }

            if (!res.ok || !data?.success) {
                return {
                    success: false,
                    error: data?.error || `Status ${res.status}`,
                    raw: data,
                };
            }

            return {
                success: true,
                tx: data.tx,
                closeTx: data.closeTx,
                refundedLamports: data.refundedLamports,
                closed: Boolean(data.closed),
                raw: data,
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    async forwardSportPositionFunding(params: {
        positionId: string;
        ownerWallet: string;
        ownerKeypair: unknown;
        fixtureId: string;
        marketType: string;
        selection: string;
        side: 'back' | 'lay';
        stakeLamports: string;
        expiresAtUnix: number;
        vaultPda?: string | null;
    }): Promise<{
        success: boolean;
        tx?: string;
        initTx?: string;
        fundingTx?: string;
        vaultPda?: string;
        ownerWallet?: string;
        error?: string;
        raw?: any;
    }> {
        try {
            const path = `/v1/sport/positions/${encodeURIComponent(params.positionId)}/execute-funding`;
            const body = JSON.stringify({
                ownerWallet: params.ownerWallet,
                ownerKeypair: params.ownerKeypair,
                fixtureId: params.fixtureId,
                marketType: params.marketType,
                selection: params.selection,
                side: params.side,
                stakeLamports: params.stakeLamports,
                expiresAtUnix: params.expiresAtUnix,
                vaultPda: params.vaultPda || null,
            });

            const res = await fetch(`${MIDDLEMAN_URL}${path}`, {
                method: 'POST',
                headers: buildSignedHeaders('POST', path, body),
                body,
                signal: AbortSignal.timeout(90000),
            });

            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = { raw: text };
            }

            if (!res.ok || !data?.success) {
                return {
                    success: false,
                    error: data?.error || `Status ${res.status}`,
                    raw: data,
                };
            }

            return {
                success: true,
                tx: data.tx,
                initTx: data.initTx,
                fundingTx: data.fundingTx || data.tx,
                vaultPda: data.vaultPda,
                ownerWallet: data.ownerWallet,
                raw: data,
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },
};
