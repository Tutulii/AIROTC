import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
  agent: {
    count: vi.fn(),
  },
  ticket: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock('../src/lib/prisma', () => ({
  prisma: prismaMock,
}));

function createResponseMock() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('stats consistency policy', () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.agent.count.mockReset();
    prismaMock.ticket.count.mockReset();
    prismaMock.ticket.findMany.mockReset();
  });

  it('computes 24h volume from completed deals only and uses completed settlements for rate', async () => {
    prismaMock.agent.count.mockResolvedValue(12);
    prismaMock.ticket.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4);
    prismaMock.ticket.findMany.mockResolvedValue([
      { offer: { price: 5, amount: 2 } },
      { offer: { price: 1.5, amount: 4 } },
    ]);

    const { getStats } = await import('../src/controllers/stats.controller');
    const req: any = {};
    const res = createResponseMock();

    await getStats(req, res);

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['completed'] },
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
          }),
        }),
      }),
    );
    expect(prismaMock.ticket.count).toHaveBeenNthCalledWith(3, {
      where: { status: { in: ['completed'] } },
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        activeDeals: 3,
        volume24h: '$16',
        settlementRate: '40.0%',
        registeredAgents: 12,
      },
    });
  });
});
