import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: any[] = [];

const prismaMock = {
    agentEvent: {
        create: vi.fn(async ({ data }) => {
            const row = {
                id: `event-${rows.length + 1}`,
                createdAt: new Date(Date.UTC(2026, 5, 29, 0, 0, rows.length)),
                deliveredAt: null,
                ackedAt: null,
                ...data,
            };
            rows.push(row);
            return row;
        }),
        findUnique: vi.fn(async ({ where }) => rows.find((row) => row.id === where.id) || null),
        findMany: vi.fn(async ({ where, take }) => {
            let result = rows.filter((row) => row.wallet === where.wallet);
            if (where.ackedAt === null) result = result.filter((row) => row.ackedAt === null);
            if (where.event?.in) result = result.filter((row) => where.event.in.includes(row.event));
            if (where.OR) {
                const markerTime = where.OR[0].createdAt.gt;
                const markerId = where.OR[1].id.gt;
                result = result.filter((row) => row.createdAt > markerTime || (row.createdAt.getTime() === markerTime.getTime() && row.id > markerId));
            }
            return result.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, take);
        }),
        updateMany: vi.fn(async ({ where, data }) => {
            let count = 0;
            for (const row of rows) {
                const idMatch = where.id?.in ? where.id.in.includes(row.id) : row.id === where.id;
                if (row.wallet === where.wallet && idMatch && (where.ackedAt !== null || row.ackedAt === null)) {
                    Object.assign(row, data);
                    count += 1;
                }
            }
            return { count };
        }),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

describe('agent event inbox', () => {
    beforeEach(() => {
        rows.splice(0);
        vi.clearAllMocks();
    });

    it('persists events and lists only unacked wallet events by default', async () => {
        const { ackAgentEvent, enqueueAgentEvent, listAgentEvents } = await import('../src/services/agentEventInbox');

        const first = await enqueueAgentEvent({
            wallet: 'wallet-1',
            event: 'dm.received',
            payload: { messageId: 'dm-1' },
        });
        await enqueueAgentEvent({
            wallet: 'wallet-2',
            event: 'dm.received',
            payload: { messageId: 'dm-2' },
        });
        await ackAgentEvent('wallet-1', first.id);
        await enqueueAgentEvent({
            wallet: 'wallet-1',
            event: 'deal.message',
            payload: { messageId: 'msg-1' },
        });

        const listed = await listAgentEvents('wallet-1');

        expect(listed.events).toHaveLength(1);
        expect(listed.events[0]).toMatchObject({
            event: 'deal.message',
            wallet: 'wallet-1',
            payload: { messageId: 'msg-1' },
        });
    });

    it('supports event filters and cursor pagination', async () => {
        const { enqueueAgentEvent, listAgentEvents } = await import('../src/services/agentEventInbox');

        const first = await enqueueAgentEvent({ wallet: 'wallet-1', event: 'dm.received', payload: {} });
        await enqueueAgentEvent({ wallet: 'wallet-1', event: 'deal.message', payload: {} });
        await enqueueAgentEvent({ wallet: 'wallet-1', event: 'deal.completed', payload: {} });

        const page = await listAgentEvents('wallet-1', {
            cursor: first.id,
            events: ['deal.message', 'deal.completed'],
            limit: 1,
        });

        expect(page.events).toHaveLength(1);
        expect(page.events[0].event).toBe('deal.message');
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBe(page.events[0].id);
    });
});
