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

    it('allows ticket messages after negotiation while delivery/release is still active', async () => {
        const createdAt = new Date('2026-06-29T00:00:00.000Z');
        prismaMock.ticket.findUnique.mockResolvedValue({
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            status: 'agreed',
            rollupMode: 'NONE',
        });
        prismaMock.message.create.mockResolvedValue({
            id: 'message-1',
            ticketId: 'ticket-1',
            sender: 'buyer-wallet',
            content: '@middleman release funds',
            createdAt,
        });

        const { createMessageService } = await import('../src/services/ticket.service');
        const message = await createMessageService('ticket-1', 'buyer-wallet', '@middleman release funds');

        expect(message).toEqual({
            id: 'message-1',
            ticketId: 'ticket-1',
            sender: 'buyer-wallet',
            content: '@middleman release funds',
            createdAt,
        });
        expect(prismaMock.message.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                ticketId: 'ticket-1',
                sender: 'buyer-wallet',
                content: '@middleman release funds',
            }),
        }));
    });

    it('blocks ticket messages after the ticket reaches a terminal status', async () => {
        prismaMock.ticket.findUnique.mockResolvedValue({
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            status: 'completed',
            rollupMode: 'NONE',
        });

        const { createMessageService } = await import('../src/services/ticket.service');

        await expect(
            createMessageService('ticket-1', 'buyer-wallet', '@middleman release funds')
        ).rejects.toThrow('TICKET_NOT_ACTIVE');

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

    it('presents SPORT ticket terms as stake without public collateral wording', async () => {
        prismaMock.ticket.findUnique.mockResolvedValue({
            id: 'ticket-sport',
            status: 'awaiting_deposits',
            rollupMode: 'SPORT',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            createdAt: new Date().toISOString(),
            offer: {
                id: 'offer-sport',
                mode: 'sell',
                asset: 'TXLINE:18179549:1X2:part1',
                price: 0.3,
                collateral: 0,
                fixtureId: '18179549',
                marketType: '1X2',
                selection: 'part1',
            },
            messages: [],
        });

        const { getTicketByIdService } = await import('../src/services/ticket.service');
        const result = await getTicketByIdService('ticket-sport', 'buyer-wallet');

        expect(result.offer).toMatchObject({
            price: 0.3,
            stake: 0.3,
            stakeModel: 'equal_stake',
            fixtureId: '18179549',
            selection: 'part1',
        });
        expect(Object.prototype.hasOwnProperty.call(result.offer, 'collateral')).toBe(false);
    });
});
