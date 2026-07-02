import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { getReplayTimeline } from './arena.service';
import { ArenaReplayEvent, ArenaStrategySignal } from './types';

const prismaAny = prisma as any;

const STRATEGY_NAME = 'sharp_movement_v1';
const SIGNAL_TYPE = 'sharp_odds_movement';
const DEFAULT_MIN_ODDS_CHANGE_PCT = 0.015;
const DEFAULT_MIN_IMPLIED_PROBABILITY_DELTA = 0.005;
const DEFAULT_MAX_STAKE_SOL = 0.1;

export interface ArenaStrategyRunOptions {
    minOddsChangePct?: number;
    minImpliedProbabilityDelta?: number;
    maxStakeSol?: number;
    limit?: number;
}

export interface ArenaStrategyRuntimeConfig {
    day: 3;
    strategy: typeof STRATEGY_NAME;
    signalType: typeof SIGNAL_TYPE;
    description: string;
    thresholds: {
        minOddsChangePct: number;
        minImpliedProbabilityDelta: number;
        maxStakeSol: number;
    };
    endpoints: string[];
    outputMode: 'signal_only';
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value: number, precision = 6): number {
    const scale = 10 ** precision;
    return Math.round(value * scale) / scale;
}

function percentLabel(value: number): string {
    return `${round(value * 100, 2).toFixed(2)}%`;
}

function probabilityPointLabel(value: number): string {
    return `${value >= 0 ? '+' : ''}${round(value * 100, 2).toFixed(2)}pp`;
}

function oddsKey(event: ArenaReplayEvent): string {
    return [
        event.fixtureId,
        event.marketType || 'unknown_market',
        event.selection || 'unknown_selection',
    ].join('|');
}

function signalDedupeKey(signal: Omit<ArenaStrategySignal, 'dedupeKey'>): string {
    return crypto
        .createHash('sha256')
        .update(stableJson({
            strategy: signal.strategy,
            fixtureId: signal.fixtureId,
            marketType: signal.marketType || null,
            selection: signal.selection || null,
            sourceEventIds: signal.sourceEventIds,
        }))
        .digest('hex');
}

function timestampMs(event: ArenaReplayEvent): number {
    const parsed = Date.parse(event.txlineTimestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}

function sortedReplayEvents(events: ArenaReplayEvent[]): ArenaReplayEvent[] {
    return [...events].sort((a, b) => {
        const time = timestampMs(a) - timestampMs(b);
        if (time !== 0) return time;
        const sequence = a.sequence - b.sequence;
        if (sequence !== 0) return sequence;
        return a.id.localeCompare(b.id);
    });
}

function buildReason(
    event: ArenaReplayEvent,
    previous: ArenaReplayEvent,
    oddsChangePct: number,
    impliedDelta: number
): string {
    const movement = impliedDelta > 0 ? 'shortened' : 'drifted';
    const market = event.marketType || 'unknown market';
    const selection = event.selection || 'unknown selection';
    return `${selection} ${movement} in ${market}: odds ${previous.oddsValue} -> ${event.oddsValue} (${percentLabel(oddsChangePct)} odds move, ${probabilityPointLabel(impliedDelta)} implied probability).`;
}

function buildConfidence(
    oddsChangePct: number,
    impliedDelta: number,
    minOddsChangePct: number,
    minImpliedProbabilityDelta: number
): number {
    const oddsRatio = Math.abs(oddsChangePct) / Math.max(minOddsChangePct, 0.000001);
    const impliedRatio = Math.abs(impliedDelta) / Math.max(minImpliedProbabilityDelta, 0.000001);
    return round(Math.min(1, Math.max(0.5, Math.max(oddsRatio, impliedRatio) / 4)), 4);
}

export function strategyRuntimeConfig(options: ArenaStrategyRunOptions = {}): ArenaStrategyRuntimeConfig {
    return {
        day: 3,
        strategy: STRATEGY_NAME,
        signalType: SIGNAL_TYPE,
        description: 'Deterministic sharp movement detector over TxLINE replay events. It compares consecutive odds for the same fixture, market, and selection, then emits signal-only trade intent when odds or implied probability move enough.',
        thresholds: {
            minOddsChangePct: positiveNumber(options.minOddsChangePct ?? process.env.TXLINE_STRATEGY_MIN_ODDS_CHANGE_PCT, DEFAULT_MIN_ODDS_CHANGE_PCT),
            minImpliedProbabilityDelta: positiveNumber(options.minImpliedProbabilityDelta ?? process.env.TXLINE_STRATEGY_MIN_IMPLIED_DELTA, DEFAULT_MIN_IMPLIED_PROBABILITY_DELTA),
            maxStakeSol: positiveNumber(options.maxStakeSol ?? process.env.TXLINE_STRATEGY_MAX_STAKE_SOL, DEFAULT_MAX_STAKE_SOL),
        },
        endpoints: [
            '/v1/txline/strategy/config',
            '/v1/txline/strategy/run/:fixtureId',
            '/v1/txline/strategy/signals/:fixtureId',
            '/v1/txline/strategy/signals/:signalId/offer',
        ],
        outputMode: 'signal_only',
    };
}

export function buildSharpMovementSignals(
    events: ArenaReplayEvent[],
    options: ArenaStrategyRunOptions = {}
): ArenaStrategySignal[] {
    const config = strategyRuntimeConfig(options);
    const { minOddsChangePct, minImpliedProbabilityDelta, maxStakeSol } = config.thresholds;
    const previousOdds = new Map<string, ArenaReplayEvent>();
    let latestScoreContext: Record<string, unknown> | undefined;
    const signals: ArenaStrategySignal[] = [];

    for (const event of sortedReplayEvents(events)) {
        if (event.type === 'score') {
            latestScoreContext = event.scoreState ? {
                ...event.scoreState,
                eventId: event.id,
                txlineTimestamp: event.txlineTimestamp,
            } : undefined;
            continue;
        }

        if (event.type !== 'odds' || typeof event.oddsValue !== 'number' || event.oddsValue <= 0) {
            continue;
        }

        const key = oddsKey(event);
        const previous = previousOdds.get(key);
        previousOdds.set(key, event);

        if (!previous || typeof previous.oddsValue !== 'number' || previous.oddsValue <= 0) {
            continue;
        }

        const oddsChangePct = (event.oddsValue - previous.oddsValue) / previous.oddsValue;
        const impliedBefore = 1 / previous.oddsValue;
        const impliedAfter = 1 / event.oddsValue;
        const impliedDelta = impliedAfter - impliedBefore;

        if (
            Math.abs(oddsChangePct) < minOddsChangePct &&
            Math.abs(impliedDelta) < minImpliedProbabilityDelta
        ) {
            continue;
        }

        const direction = impliedDelta >= 0 ? 'BUY_SELECTION' : 'SELL_SELECTION';
        const confidence = buildConfidence(oddsChangePct, impliedDelta, minOddsChangePct, minImpliedProbabilityDelta);
        const signalWithoutDedupe: Omit<ArenaStrategySignal, 'dedupeKey'> = {
            strategy: STRATEGY_NAME,
            signalType: SIGNAL_TYPE,
            fixtureId: event.fixtureId,
            marketType: event.marketType,
            selection: event.selection,
            direction,
            confidence,
            oddsBefore: previous.oddsValue,
            oddsAfter: event.oddsValue,
            oddsChangePct: round(oddsChangePct),
            impliedBefore: round(impliedBefore),
            impliedAfter: round(impliedAfter),
            impliedDelta: round(impliedDelta),
            scoreContext: latestScoreContext,
            tradeIntent: {
                mode: 'signal_only',
                action: direction === 'BUY_SELECTION' ? 'quote_buy' : 'quote_sell',
                fixtureId: event.fixtureId,
                marketType: event.marketType,
                selection: event.selection,
                confidence,
                rollupMode: 'NONE',
                maxStakeSol,
            },
            reason: buildReason(event, previous, oddsChangePct, impliedDelta),
            sourceEventIds: [previous.id, event.id],
            signalTimestamp: event.txlineTimestamp,
        };

        signals.push({
            ...signalWithoutDedupe,
            dedupeKey: signalDedupeKey(signalWithoutDedupe),
        });
    }

    return signals;
}

export function serializeStrategySignal(row: any): Record<string, unknown> {
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        strategy: row.strategy,
        signalType: row.signalType,
        marketType: row.marketType || undefined,
        selection: row.selection || undefined,
        direction: row.direction,
        confidence: row.confidence,
        oddsBefore: row.oddsBefore ?? undefined,
        oddsAfter: row.oddsAfter ?? undefined,
        oddsChangePct: row.oddsChangePct ?? undefined,
        impliedBefore: row.impliedBefore ?? undefined,
        impliedAfter: row.impliedAfter ?? undefined,
        impliedDelta: row.impliedDelta ?? undefined,
        scoreContext: row.scoreContext || undefined,
        tradeIntent: row.tradeIntent,
        reason: row.reason,
        sourceEventIds: row.sourceEventIds,
        signalTimestamp: row.signalTimestamp instanceof Date
            ? row.signalTimestamp.toISOString()
            : new Date(row.signalTimestamp).toISOString(),
        dedupeKey: row.dedupeKey,
        createdAt: row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
    };
}

export async function runStrategyForFixture(
    fixtureId: string,
    options: ArenaStrategyRunOptions = {}
): Promise<Record<string, unknown>> {
    const limit = Math.min(Math.max(Math.floor(options.limit || 1000), 1), 5000);
    const replay = await getReplayTimeline(fixtureId, limit);
    const events = Array.isArray(replay.events) ? replay.events as ArenaReplayEvent[] : [];
    const signals = buildSharpMovementSignals(events, options);

    let inserted = 0;
    if (signals.length > 0) {
        const result = await prismaAny.arenaStrategySignal.createMany({
            data: signals.map((signal) => ({
                fixtureId: signal.fixtureId,
                strategy: signal.strategy,
                signalType: signal.signalType,
                marketType: signal.marketType || null,
                selection: signal.selection || null,
                direction: signal.direction,
                confidence: signal.confidence,
                oddsBefore: signal.oddsBefore ?? null,
                oddsAfter: signal.oddsAfter ?? null,
                oddsChangePct: signal.oddsChangePct ?? null,
                impliedBefore: signal.impliedBefore ?? null,
                impliedAfter: signal.impliedAfter ?? null,
                impliedDelta: signal.impliedDelta ?? null,
                scoreContext: signal.scoreContext ? jsonValue(signal.scoreContext) : null,
                tradeIntent: jsonValue(signal.tradeIntent),
                reason: signal.reason,
                sourceEventIds: jsonValue(signal.sourceEventIds),
                signalTimestamp: new Date(signal.signalTimestamp),
                dedupeKey: signal.dedupeKey,
            })),
            skipDuplicates: true,
        });
        inserted = typeof result?.count === 'number' ? result.count : signals.length;
    }

    return {
        fixtureId,
        strategy: STRATEGY_NAME,
        deterministic: true,
        evaluatedEvents: events.length,
        generatedSignals: signals.length,
        insertedSignals: inserted,
        thresholds: strategyRuntimeConfig(options).thresholds,
        signals,
    };
}

export async function listStrategySignals(fixtureId: string, limit = 50): Promise<Record<string, unknown>> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = await prismaAny.arenaStrategySignal.findMany({
        where: { fixtureId },
        orderBy: [{ signalTimestamp: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: boundedLimit,
    });

    return {
        fixtureId,
        strategy: STRATEGY_NAME,
        count: rows.length,
        signals: rows.map(serializeStrategySignal),
    };
}
