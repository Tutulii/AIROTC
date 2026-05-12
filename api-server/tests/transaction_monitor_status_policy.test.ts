import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  ticket: {
    count: vi.fn(),
  },
  agent: {
    count: vi.fn(),
  },
  offer: {
    count: vi.fn(),
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
    prismaMock.ticket.count.mockReset();
    prismaMock.agent.count.mockReset();
    prismaMock.offer.count.mockReset();
    prismaMock.message.count.mockReset();
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
});
