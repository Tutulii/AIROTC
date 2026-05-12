import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    ticket: {
        findUnique: vi.fn(),
    },
    message: {
        create: vi.fn(),
    },
};

const emitMock = vi.fn();

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/utils/validators', () => ({
    isUUID: vi.fn(() => true),
    assertParticipant: vi.fn(),
}));

vi.mock('../src/ws/socket', () => ({
    getIO: vi.fn(() => ({
        to: vi.fn(() => ({
            emit: emitMock,
        })),
    })),
}));

vi.mock('../src/services/webhook.service', () => ({
    webhookNewMessage: vi.fn(),
}));

describe('PER ticket redaction', () => {
    beforeEach(() => {
        vi.resetModules();
        prismaMock.ticket.findUnique.mockReset();
        prismaMock.message.create.mockReset();
        emitMock.mockReset();
        delete process.env.PER_STRICT_OPAQUE_MODE;
    });

    afterEach(() => {
        delete process.env.PER_STRICT_OPAQUE_MODE;
    });

    it('redacts offer price and collateral when fetching a strict PER ticket', async () => {
        prismaMock.ticket.findUnique.mockResolvedValue({
            id: 'ticket-1',
            status: 'negotiating',
            rollupMode: 'PER',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            createdAt: new Date().toISOString(),
            offer: {
                id: 'offer-1',
                mode: 'sell',
                asset: 'SOL',
                price: 5,
                collateral: 2,
            },
            messages: [],
        });

        const { getTicketByIdService } = await import('../src/services/ticket.service');
        const result = await getTicketByIdService('ticket-1', 'buyer-wallet');

        expect(result.privateTermsRedacted).toBe(true);
        expect(result.offer.price).toBeNull();
        expect(result.offer.collateral).toBeNull();
        expect(result.offer.privateTermsRedacted).toBe(true);
    });

    it('blocks plaintext PER term messages before persistence', async () => {
        prismaMock.ticket.findUnique.mockResolvedValue({
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            status: 'negotiating',
            rollupMode: 'PER',
        });

        const { createMessageService } = await import('../src/services/ticket.service');

        await expect(
            createMessageService('ticket-1', 'buyer-wallet', 'Price 5 SOL and collateral 2 SOL.')
        ).rejects.toThrow('PER_PLAINTEXT_TERMS_BLOCKED');

        expect(prismaMock.message.create).not.toHaveBeenCalled();
    });

    it('keeps ER matched ticket terms visible', async () => {
        prismaMock.ticket.findUnique.mockResolvedValue({
            id: 'ticket-2',
            status: 'negotiating',
            rollupMode: 'ER',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            createdAt: new Date().toISOString(),
            offer: {
                id: 'offer-2',
                mode: 'sell',
                asset: 'SOL',
                price: 7,
                collateral: 1.5,
            },
            messages: [],
        });

        const { getTicketByIdService } = await import('../src/services/ticket.service');
        const result = await getTicketByIdService('ticket-2', 'buyer-wallet');

        expect(result.privateTermsRedacted).toBe(false);
        expect(result.offer.price).toBe(7);
        expect(result.offer.collateral).toBe(1.5);
    });
});
