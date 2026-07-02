import {
    ODDS_STREAM_ENDPOINT,
    SCORES_STREAM_ENDPOINT,
    normalizeOddsPayload,
    normalizeScoresPayload,
    readTxlineSseStream,
    txlineActiveFixtureSource,
    txlineAuthConfigured,
    txlineFallbackEnabled,
} from './txlineClient';
import { recordOddsUpdates, recordScoreUpdates, syncFixturesFromTxline } from './arena.service';

type StreamName = 'odds' | 'scores';

interface StreamState {
    endpoint: string;
    connected: boolean;
    events: number;
    updates: number;
    lastMessageAt?: string;
    lastError?: string;
}

interface IngestionState {
    running: boolean;
    mode: 'txline_stream' | 'scoreboard_fallback' | 'unconfigured';
    source: string;
    startedAt?: string;
    stoppedAt?: string;
    fixtures: StreamState;
    odds: StreamState;
    scores: StreamState;
}

const state: IngestionState = {
    running: false,
    mode: 'unconfigured',
    source: txlineActiveFixtureSource(),
    fixtures: {
        endpoint: '/v1/txline/fixtures',
        connected: false,
        events: 0,
        updates: 0,
    },
    odds: {
        endpoint: ODDS_STREAM_ENDPOINT,
        connected: false,
        events: 0,
        updates: 0,
    },
    scores: {
        endpoint: SCORES_STREAM_ENDPOINT,
        connected: false,
        events: 0,
        updates: 0,
    },
};

let controller: AbortController | null = null;
let fallbackInterval: NodeJS.Timeout | null = null;

function cloneState(): IngestionState {
    return JSON.parse(JSON.stringify(state));
}

function fixtureSyncIntervalMs(): number {
    return Math.max(Number(process.env.TXLINE_FIXTURE_SYNC_INTERVAL_MS) || 120_000, 30_000);
}

async function syncFallbackFixtures(): Promise<void> {
    state.fixtures.connected = true;
    state.fixtures.lastError = undefined;
    try {
        const result = await syncFixturesFromTxline();
        state.fixtures.events += 1;
        state.fixtures.updates += Number(result.count || 0);
        state.fixtures.lastMessageAt = new Date().toISOString();
    } catch (error: any) {
        state.fixtures.lastError = error?.message || 'txline_fixture_fallback_sync_failed';
    } finally {
        state.fixtures.connected = false;
    }
}

async function runStream(name: StreamName, endpoint: string, signal: AbortSignal): Promise<void> {
    const streamState = state[name];
    streamState.connected = true;
    streamState.lastError = undefined;
    try {
        await readTxlineSseStream(endpoint, {
            signal,
            onMessage: async (message) => {
                streamState.events += 1;
                streamState.lastMessageAt = new Date().toISOString();
                if (name === 'odds') {
                    const updates = normalizeOddsPayload(message.data);
                    if (updates.length > 0) {
                        await recordOddsUpdates(updates);
                        streamState.updates += updates.length;
                    }
                } else {
                    const updates = normalizeScoresPayload(message.data);
                    if (updates.length > 0) {
                        await recordScoreUpdates(updates);
                        streamState.updates += updates.length;
                    }
                }
            },
        });
    } catch (error: any) {
        if (!signal.aborted) {
            streamState.lastError = error?.message || 'txline_stream_failed';
        }
    } finally {
        streamState.connected = false;
    }
}

export function getTxlineIngestionStatus(): IngestionState {
    return cloneState();
}

export function startTxlineIngestion(): IngestionState {
    if (state.running) return cloneState();

    state.source = txlineActiveFixtureSource();
    controller = new AbortController();
    state.running = true;
    state.startedAt = new Date().toISOString();
    state.stoppedAt = undefined;
    state.mode = txlineAuthConfigured() ? 'txline_stream' : txlineFallbackEnabled() ? 'scoreboard_fallback' : 'unconfigured';
    state.fixtures.lastError = undefined;
    state.odds.lastError = undefined;
    state.scores.lastError = undefined;

    if (!txlineAuthConfigured()) {
        if (!txlineFallbackEnabled()) {
            state.running = false;
            state.stoppedAt = new Date().toISOString();
            state.fixtures.lastError = 'TXLINE_API_TOKEN is required and scoreboard fallback is disabled';
            return cloneState();
        }

        void syncFallbackFixtures();
        fallbackInterval = setInterval(() => {
            void syncFallbackFixtures();
        }, fixtureSyncIntervalMs());
        return cloneState();
    }

    void Promise.allSettled([
        runStream('odds', ODDS_STREAM_ENDPOINT, controller.signal),
        runStream('scores', SCORES_STREAM_ENDPOINT, controller.signal),
    ]).finally(() => {
        if (!controller?.signal.aborted) {
            state.running = false;
            state.stoppedAt = new Date().toISOString();
        }
    });

    return cloneState();
}

export function stopTxlineIngestion(): IngestionState {
    if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
    }
    if (controller) {
        controller.abort();
        controller = null;
    }
    state.running = false;
    state.stoppedAt = new Date().toISOString();
    state.fixtures.connected = false;
    state.odds.connected = false;
    state.scores.connected = false;
    return cloneState();
}
