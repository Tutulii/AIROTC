import {
    ODDS_STREAM_ENDPOINT,
    SCORES_STREAM_ENDPOINT,
    normalizeOddsPayload,
    normalizeScoresPayload,
    readTxlineSseStream,
} from './txlineClient';
import { recordOddsUpdates, recordScoreUpdates } from './arena.service';

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
    startedAt?: string;
    stoppedAt?: string;
    odds: StreamState;
    scores: StreamState;
}

const state: IngestionState = {
    running: false,
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

function cloneState(): IngestionState {
    return JSON.parse(JSON.stringify(state));
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

    controller = new AbortController();
    state.running = true;
    state.startedAt = new Date().toISOString();
    state.stoppedAt = undefined;
    state.odds.lastError = undefined;
    state.scores.lastError = undefined;

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
    if (controller) {
        controller.abort();
        controller = null;
    }
    state.running = false;
    state.stoppedAt = new Date().toISOString();
    state.odds.connected = false;
    state.scores.connected = false;
    return cloneState();
}
