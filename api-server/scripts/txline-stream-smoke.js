#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '../..');
const apiRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(apiRoot, '.env') });

const DEFAULT_DURATION_SECONDS = 90;
const STREAMS = [
    { name: 'odds', endpoint: '/api/odds/stream' },
    { name: 'scores', endpoint: '/api/scores/stream' },
];

function baseUrl() {
    return String(process.env.TXLINE_API_BASE_URL || 'https://txline-dev.txodds.com').replace(/\/$/, '');
}

function assertSafeNetwork(base) {
    const network = process.env.TXLINE_NETWORK || (base.includes('txline-dev.txodds.com') ? 'devnet' : 'mainnet');
    if (network === 'devnet' && !base.includes('txline-dev.txodds.com')) {
        throw new Error(`Refusing devnet stream smoke against non-devnet TxLINE base: ${base}`);
    }
    if (network === 'mainnet' && base.includes('txline-dev.txodds.com')) {
        throw new Error(`Refusing mainnet stream smoke against devnet TxLINE base: ${base}`);
    }
    return network;
}

async function guestJwt(base) {
    const response = await fetch(`${base}/auth/guest/start`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || typeof payload.token !== 'string') {
        throw new Error(`TxLINE guest auth failed ${response.status}: ${text}`);
    }
    return payload.token;
}

function parseSseMessages(buffer) {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const chunks = normalized.split('\n\n');
    const remainder = chunks.pop() || '';
    const messages = [];

    for (const chunk of chunks) {
        let event;
        let id;
        const dataLines = [];

        for (const line of chunk.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const separator = line.indexOf(':');
            const field = separator === -1 ? line : line.slice(0, separator);
            const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            if (field === 'id') id = value;
            if (field === 'data') dataLines.push(value);
        }

        if (dataLines.length === 0) continue;
        const text = dataLines.join('\n');
        let data = text;
        try {
            data = JSON.parse(text);
        } catch {
            // Keep non-JSON control frames as text.
        }
        messages.push({ event, id, data });
    }

    return { messages, remainder };
}

function rowArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['data', 'updates', 'odds', 'scores', 'items', 'results']) {
        const value = payload[key];
        if (Array.isArray(value)) return value;
    }
    return [payload];
}

function fixtureId(data) {
    const rows = rowArray(data);
    const row = rows.find((item) => item && typeof item === 'object') || {};
    return row.FixtureId || row.fixtureId || row.fixture_id || row.MatchId || row.matchId || null;
}

function summarizeMessage(message) {
    const rows = rowArray(message.data);
    const first = rows.find((item) => item && typeof item === 'object') || {};
    return {
        id: message.id || null,
        event: message.event || null,
        fixtureId: fixtureId(message.data),
        rowCount: rows.length,
        keys: Object.keys(first).slice(0, 12),
    };
}

async function connectStream({ name, endpoint }, options) {
    const state = {
        name,
        endpoint,
        connected: false,
        status: null,
        contentType: null,
        startedAt: new Date().toISOString(),
        connectedAt: null,
        endedAt: null,
        durationMs: 0,
        chunks: 0,
        bytes: 0,
        events: 0,
        firstEventAt: null,
        lastEventAt: null,
        samples: [],
        error: null,
    };

    const started = Date.now();
    let reader;
    let buffer = '';

    try {
        const token = await guestJwt(options.base);
        const response = await fetch(`${options.base}${endpoint}`, {
            method: 'GET',
            headers: {
                Accept: 'text/event-stream',
                Authorization: `Bearer ${token}`,
                'X-Api-Token': options.apiToken,
            },
            signal: options.signal,
        });

        state.status = response.status;
        state.contentType = response.headers.get('content-type');
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
        }
        if (!response.body) throw new Error('stream response had no body');

        state.connected = true;
        state.connectedAt = new Date().toISOString();
        reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            state.chunks += 1;
            state.bytes += value.byteLength;
            buffer += decoder.decode(value, { stream: true });

            const parsed = parseSseMessages(buffer);
            buffer = parsed.remainder;
            for (const message of parsed.messages) {
                state.events += 1;
                const now = new Date().toISOString();
                state.firstEventAt = state.firstEventAt || now;
                state.lastEventAt = now;
                if (state.samples.length < 3) state.samples.push(summarizeMessage(message));
            }
        }
    } catch (error) {
        if (error?.name !== 'AbortError') {
            state.error = error?.message || String(error);
        }
    } finally {
        try {
            await reader?.cancel();
        } catch {
            // Ignore cancel races after abort.
        }
        state.endedAt = new Date().toISOString();
        state.durationMs = Date.now() - started;
        state.connected = state.status === 200 && !state.error;
    }

    return state;
}

async function main() {
    const base = baseUrl();
    const network = assertSafeNetwork(base);
    const apiToken = process.env.TXLINE_API_TOKEN || process.env.TXLINE_API_KEY;
    if (!apiToken) throw new Error('TXLINE_API_TOKEN is required for stream smoke.');

    const durationSeconds = Number(process.env.TXLINE_STREAM_SMOKE_SECONDS || DEFAULT_DURATION_SECONDS);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 10) {
        throw new Error('TXLINE_STREAM_SMOKE_SECONDS must be at least 10.');
    }

    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const timeout = setTimeout(() => controller.abort(), durationSeconds * 1000);

    const results = await Promise.all(STREAMS.map((stream) => connectStream(stream, {
        base,
        apiToken,
        signal: controller.signal,
    })));
    clearTimeout(timeout);

    const endedAt = new Date().toISOString();
    const ok = results.every((result) => result.status === 200 && !result.error && result.durationMs >= (durationSeconds * 1000 - 2_500));
    const proof = {
        ok,
        network,
        base,
        startedAt,
        endedAt,
        requestedDurationSeconds: durationSeconds,
        tokenConfigured: true,
        tokenLength: apiToken.length,
        streams: results,
    };

    const proofDir = path.join(repoRoot, 'tmp', 'txline-day2');
    fs.mkdirSync(proofDir, { recursive: true });
    const proofPath = path.join(proofDir, `txline-stream-smoke-${network}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));

    console.log(JSON.stringify({
        ok,
        network,
        base,
        requestedDurationSeconds: durationSeconds,
        proofPath,
        streams: results.map((result) => ({
            name: result.name,
            endpoint: result.endpoint,
            status: result.status,
            contentType: result.contentType,
            durationMs: result.durationMs,
            chunks: result.chunks,
            bytes: result.bytes,
            events: result.events,
            firstEventAt: result.firstEventAt,
            lastEventAt: result.lastEventAt,
            samples: result.samples,
            error: result.error,
        })),
    }, null, 2));

    if (!ok) process.exitCode = 1;
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
});
