import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  $transaction: vi.fn(),
  ticket: {
    count: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  agent: {
    count: vi.fn(),
  },
  offer: {
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  message: {
    count: vi.fn(),
  },
};

vi.mock('../src/lib/prisma', () => ({
  prisma: prismaMock,
}));

vi.mock('../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  logDrain: {
    getAlerts: vi.fn(() => []),
  },
}));

describe('transaction monitor status policy', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.STALE_NEGOTIATION_CANCEL_MS;
    delete process.env.STALE_NEGOTIATION_AUTO_CANCEL;
    prismaMock.$transaction.mockReset();
    prismaMock.ticket.count.mockReset();
    prismaMock.ticket.findMany.mockReset();
    prismaMock.ticket.updateMany.mockReset();
    prismaMock.agent.count.mockReset();
    prismaMock.offer.count.mockReset();
    prismaMock.offer.updateMany.mockReset();
    prismaMock.message.count.mockReset();
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.offer.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.$transaction.mockImplementation(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
  });

  it('counts completed deals using the final completed status', async () => {
    prismaMock.ticket.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    prismaMock.agent.count.mockResolvedValue(9);
    prismaMock.offer.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(11);
    prismaMock.message.count.mockResolvedValue(25);

    const { getMetrics } = await import('../src/services/transactionMonitor');
    const metrics = await getMetrics();

    expect(prismaMock.ticket.count).toHaveBeenNthCalledWith(3, {
      where: { status: { in: ['completed'] } },
    });
    expect(metrics.completedDeals).toBe(4);
    expect(metrics.settlementRate).toBe(0.4);
  });

  it('auto-cancels stale negotiating tickets using last message activity', async () => {
    process.env.STALE_NEGOTIATION_CANCEL_MS = '1000';
    const now = new Date('2026-06-28T00:00:05.000Z').getTime();
    const staleCreatedAt = new Date('2026-06-28T00:00:00.000Z');
    const freshMessageAt = new Date('2026-06-28T00:00:04.500Z');

    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'stale-ticket',
        offerId: 'stale-offer',
        createdAt: staleCreatedAt,
        messages: [],
      },
      {
        id: 'active-ticket',
        offerId: 'active-offer',
        createdAt: staleCreatedAt,
        messages: [{ createdAt: freshMessageAt }],
      },
    ]);

    const { cancelStaleNegotiationTickets } = await import('../src/services/transactionMonitor');
    const cancelled = await cancelStaleNegotiationTickets(now);

    expect(cancelled).toBe(1);
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { id: 'stale-ticket', status: 'negotiating' },
      data: { status: 'cancelled' },
    });
    expect(prismaMock.offer.updateMany).toHaveBeenCalledWith({
      where: { id: 'stale-offer', status: 'matched' },
      data: { status: 'cancelled' },
    });
  });
});
