import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncFixturesFromTxlineMock = vi.hoisted(() => vi.fn());
const readTxlineSseStreamMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/arena/arena.service', () => ({
    recordOddsUpdates: vi.fn(async () => 0),
    recordScoreUpdates: vi.fn(async () => 0),
    syncFixturesFromTxline: syncFixturesFromTxlineMock,
}));

vi.mock('../src/services/arena/txlineClient', () => ({
    ODDS_STREAM_ENDPOINT: '/api/odds/stream',
    SCORES_STREAM_ENDPOINT: '/api/scores/stream',
    normalizeOddsPayload: vi.fn(() => []),
    normalizeScoresPayload: vi.fn(() => []),
    readTxlineSseStream: readTxlineSseStreamMock,
    txlineActiveFixtureSource: vi.fn(() => 'txline'),
    txlineAuthConfigured: vi.fn(() => true),
}));

async function eventually(assertion: () => void): Promise<void> {
    const deadline = Date.now() + 500;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw lastError;
}

describe('TxLINE ingestion status', () => {
    beforeEach(() => {
        vi.resetModules();
        syncFixturesFromTxlineMock.mockResolvedValue({ count: 13, fixtures: [] });
        readTxlineSseStreamMock.mockImplementation((_endpoint: string, options: { signal: AbortSignal }) => new Promise<void>((resolve) => {
            options.signal.addEventListener('abort', () => resolve(), { once: true });
        }));
    });

    afterEach(async () => {
        const service = await import('../src/services/arena/txlineStreamIngestion');
        service.stopTxlineIngestion();
        vi.clearAllMocks();
    });

    it('syncs fixture snapshots in TxLINE stream mode instead of reporting fixtures as down', async () => {
        const service = await import('../src/services/arena/txlineStreamIngestion');

        const started = service.startTxlineIngestion();

        expect(started.mode).toBe('txline_stream');
        expect(started.fixtures.kind).toBe('snapshot');
        expect(started.odds.kind).toBe('sse');
        expect(started.scores.kind).toBe('sse');

        await eventually(() => {
            const status = service.getTxlineIngestionStatus();
            expect(status.fixtures.connected).toBe(true);
            expect(status.fixtures.events).toBe(1);
            expect(status.fixtures.updates).toBe(13);
            expect(status.fixtures.lastError).toBeUndefined();
        });

        expect(syncFixturesFromTxlineMock).toHaveBeenCalledTimes(1);
    });
});
