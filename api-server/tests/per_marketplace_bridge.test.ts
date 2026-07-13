import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/hmacSigner', () => ({
    signRequest: vi.fn(() => ({
        signature: 'test-signature',
        timestamp: '1700000000',
    })),
}));

describe('middlemanForwarder PER bridge redaction', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.resetModules();
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock as any);
        process.env.MIDDLEMAN_URL = 'http://middleman.test';
        delete process.env.PER_STRICT_OPAQUE_MODE;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.MIDDLEMAN_URL;
        delete process.env.PER_STRICT_OPAQUE_MODE;
    });

    it('redacts price and collateral when a PER offer is accepted in strict mode', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ ticketId: 'middleman-ticket-1' }),
        });

        const { middlemanForwarder } = await import('../src/services/middlemanForwarder');

        const result = await middlemanForwarder.forwardOfferAccepted({
            ticketId: 'ticket-1',
            buyerWallet: 'buyer-wallet',
            sellerWallet: 'seller-wallet',
            asset: 'SOL',
            price: 5,
            amount: 1,
            collateral: 2,
            rollupMode: 'PER',
        });

        expect(result).toEqual({
            success: true,
            middlemanTicketId: 'middleman-ticket-1',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(request.body));
        expect(body.rollupMode).toBe('PER');
        expect(body.price).toBeNull();
        expect(body.collateral).toBeNull();
        expect(body.amount).toBe('1');
        expect(body.asset).toBe('SOL');
    });

    it('forwards fresh buyer and seller reward wallets on the matched bridge payload', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ ticketId: 'middleman-ticket-4' }),
        });

        const { middlemanForwarder } = await import('../src/services/middlemanForwarder');

        await middlemanForwarder.forwardOfferAccepted({
            ticketId: 'ticket-4',
            buyerWallet: 'buyer-wallet',
            sellerWallet: 'seller-wallet',
            buyerSettlementWallet: 'buyer-settlement-wallet',
            sellerSettlementWallet: 'seller-settlement-wallet',
            buyerRewardWallet: 'buyer-reward-wallet',
            sellerRewardWallet: 'seller-reward-wallet',
            asset: 'SOL',
            price: 5,
            amount: 1,
            collateral: 2,
            rollupMode: 'PER',
        });

        const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(request.body));
        expect(body.buyerRewardWallet).toBe('buyer-reward-wallet');
        expect(body.sellerRewardWallet).toBe('seller-reward-wallet');
        expect(body.buyerSettlementWallet).toBe('buyer-settlement-wallet');
        expect(body.sellerSettlementWallet).toBe('seller-settlement-wallet');
    });

    it('preserves ER price and collateral on the bridge payload', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ ticketId: 'middleman-ticket-2' }),
        });

        const { middlemanForwarder } = await import('../src/services/middlemanForwarder');

        await middlemanForwarder.forwardOfferAccepted({
            ticketId: 'ticket-2',
            buyerWallet: 'buyer-wallet',
            sellerWallet: 'seller-wallet',
            asset: 'SOL',
            price: 7.5,
            amount: 3,
            collateral: 1.25,
            rollupMode: 'ER',
        });

        const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(request.body));
        expect(body.rollupMode).toBe('ER');
        expect(body.price).toBe('7.5');
        expect(body.collateral).toBe('1.25');
    });

    it('allows non-strict PER bridge mode to preserve legacy term forwarding', async () => {
        process.env.PER_STRICT_OPAQUE_MODE = 'false';
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ ticketId: 'middleman-ticket-3' }),
        });

        const { middlemanForwarder } = await import('../src/services/middlemanForwarder');

        await middlemanForwarder.forwardOfferAccepted({
            ticketId: 'ticket-3',
            buyerWallet: 'buyer-wallet',
            sellerWallet: 'seller-wallet',
            asset: 'SOL',
            price: 9,
            amount: 2,
            collateral: 4,
            rollupMode: 'PER',
        });

        const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(request.body));
        expect(body.rollupMode).toBe('PER');
        expect(body.price).toBe('9');
        expect(body.collateral).toBe('4');
    });

    it('uses a longer bridge timeout for SPORT accept because escrow is created immediately', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                ticketId: 'sport-ticket-1',
                phase: 'awaiting_deposits',
                dealPda: 'escrow-pda-1',
            }),
        });
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

        const { middlemanForwarder } = await import('../src/services/middlemanForwarder');

        const result = await middlemanForwarder.forwardOfferAccepted({
            ticketId: 'sport-ticket-1',
            buyerWallet: 'buyer-wallet',
            sellerWallet: 'seller-wallet',
            asset: 'TXLINE:18179549:1X2:part1',
            price: 0.1,
            amount: 4,
            collateral: 1,
            rollupMode: 'SPORT',
        });

        expect(timeoutSpy).toHaveBeenCalledWith(60_000);
        expect(result).toMatchObject({
            success: true,
            middlemanTicketId: 'sport-ticket-1',
            phase: 'awaiting_deposits',
            dealPda: 'escrow-pda-1',
        });
        timeoutSpy.mockRestore();
    });
});
