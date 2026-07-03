import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { fetchScoresSnapshot } from './txlineClient';
import { recordScoreUpdates } from './arena.service';
import {
    ArenaBacktestEvaluation,
    ArenaOutcomeInput,
    ArenaOutcomeWinner,
    TxlineScoreUpdate,
} from './types';

const prismaAny = prisma as any;
const FINAL_STATUSES = new Set([
    'final',
    'finished',
    'finish',
    'ended',
    'end',
    'complete',
    'completed',
    'closed',
    'settled',
    'result',
    'full_time',
    'fulltime',
    'ft',
    'after_extra_time',
    'aet',
    'after_penalties',
]);

export function isTrustedOutcomeSource(source: unknown): boolean {
    const normalized = String(source || '').trim().toLowerCase();
    return normalized === 'txline' || normalized.startsWith('txline_');
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nested(value: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => asRecord(current)[key], value);
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = key.includes('.') ? nested(source, key) : source[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return undefined;
}

function normalizeStatus(value: unknown): string {
    return String(value || 'unknown').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isFinalOutcomeStatus(status: unknown, action?: unknown): boolean {
    const normalizedStatus = normalizeStatus(status);
    const normalizedAction = normalizeStatus(action);
    return FINAL_STATUSES.has(normalizedStatus) || FINAL_STATUSES.has(normalizedAction);
}

export function winnerFromScore(homeScore: number, awayScore: number): ArenaOutcomeWinner {
    if (homeScore > awayScore) return 'part1';
    if (awayScore > homeScore) return 'part2';
    return 'draw';
}

export function extractScore(raw: Record<string, unknown>, fallback?: { homeScore?: number; awayScore?: number }): { homeScore?: number; awayScore?: number } {
    return {
        homeScore: fallback?.homeScore ?? firstNumber(raw, [
            'homeScore',
            'home_score',
            'score.home',
            'home.score',
            'Score.Participant1.Total.Goals',
            'Score.Home',
            'Score.home',
            'Data.New.Score.Participant1.Total.Goals',
            'Data.Score.Participant1.Total.Goals',
            'Data.New.homeScore',
            'Data.homeScore',
            'normalizedScoreState.homeScore',
        ]),
        awayScore: fallback?.awayScore ?? firstNumber(raw, [
            'awayScore',
            'away_score',
            'score.away',
            'away.score',
            'Score.Participant2.Total.Goals',
            'Score.Away',
            'Score.away',
            'Data.New.Score.Participant2.Total.Goals',
            'Data.Score.Participant2.Total.Goals',
            'Data.New.awayScore',
            'Data.awayScore',
            'normalizedScoreState.awayScore',
        ]),
    };
}

export function deriveOutcomeFromScoreUpdate(update: TxlineScoreUpdate): ArenaOutcomeInput | null {
    if (!isTrustedOutcomeSource(update.source)) return null;

    const raw = asRecord(update.raw);
    const normalizedState = asRecord(raw.normalizedScoreState);
    const status = update.status || String(normalizedState.status || raw.GameState || raw.status || 'unknown');
    const action = raw.Action || normalizedState.action;
    const { homeScore, awayScore } = extractScore(raw, {
        homeScore: update.homeScore,
        awayScore: update.awayScore,
    });

    if (
        typeof homeScore !== 'number' ||
        typeof awayScore !== 'number' ||
        !isFinalOutcomeStatus(status, action)
    ) {
        return null;
    }

    return {
        fixtureId: update.fixtureId,
        status,
        homeScore,
        awayScore,
        winner: winnerFromScore(homeScore, awayScore),
        source: update.source,
        sourceUpdateId: update.sourceUpdateId,
        sourceTimestamp: update.sourceTimestamp,
        settledAt: update.sourceTimestamp,
        raw,
    };
}

export async function upsertOutcome(outcome: ArenaOutcomeInput): Promise<Record<string, unknown>> {
    return prismaAny.arenaOutcome.upsert({
        where: { fixtureId: outcome.fixtureId },
        update: {
            status: outcome.status,
            homeScore: outcome.homeScore,
            awayScore: outcome.awayScore,
            winner: outcome.winner,
            source: outcome.source,
            sourceUpdateId: outcome.sourceUpdateId || null,
            sourceTimestamp: outcome.sourceTimestamp,
            settledAt: outcome.settledAt,
            raw: jsonValue(outcome.raw),
        },
        create: {
            fixtureId: outcome.fixtureId,
            status: outcome.status,
            homeScore: outcome.homeScore,
            awayScore: outcome.awayScore,
            winner: outcome.winner,
            source: outcome.source,
            sourceUpdateId: outcome.sourceUpdateId || null,
            sourceTimestamp: outcome.sourceTimestamp,
            settledAt: outcome.settledAt,
            raw: jsonValue(outcome.raw),
        },
    });
}

export async function syncOutcomeForFixture(fixtureId: string): Promise<Record<string, unknown>> {
    const updates = await fetchScoresSnapshot(fixtureId);
    await recordScoreUpdates(updates);
    const outcomes = updates
        .map(deriveOutcomeFromScoreUpdate)
        .filter((outcome): outcome is ArenaOutcomeInput => Boolean(outcome))
        .sort((a, b) => b.sourceTimestamp.getTime() - a.sourceTimestamp.getTime());

    if (outcomes.length === 0) {
        return {
            fixtureId,
            scoreUpdates: updates.length,
            outcome: null,
            stored: false,
            reason: 'no_final_score_in_txline_snapshot',
        };
    }

    const stored = await upsertOutcome(outcomes[0]);
    return {
        fixtureId,
        scoreUpdates: updates.length,
        outcome: serializeOutcome(stored),
        stored: true,
    };
}

export async function deriveOutcomesFromStoredScores(fixtureId?: string): Promise<Record<string, unknown>> {
    const rows = await prismaAny.arenaScoreUpdate.findMany({
        where: fixtureId ? { fixtureId } : {},
        orderBy: [{ sourceTimestamp: 'desc' }, { createdAt: 'desc' }],
        take: 10_000,
    });
    const latestByFixture = new Map<string, ArenaOutcomeInput>();
    for (const row of rows) {
        if (latestByFixture.has(row.fixtureId)) continue;
        const outcome = deriveOutcomeFromScoreUpdate({
            fixtureId: row.fixtureId,
            homeScore: row.homeScore ?? undefined,
            awayScore: row.awayScore ?? undefined,
            status: row.status,
            source: row.source,
            sourceUpdateId: row.sourceUpdateId ?? undefined,
            sourceTimestamp: row.sourceTimestamp,
            raw: row.raw || {},
        });
        if (outcome) latestByFixture.set(row.fixtureId, outcome);
    }

    const stored = [];
    for (const outcome of latestByFixture.values()) {
        stored.push(serializeOutcome(await upsertOutcome(outcome)));
    }

    return {
        fixtureId: fixtureId || null,
        scannedScoreRows: rows.length,
        storedOutcomes: stored.length,
        outcomes: stored,
    };
}

export function serializeOutcome(row: any): Record<string, unknown> {
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        status: row.status,
        homeScore: row.homeScore,
        awayScore: row.awayScore,
        winner: row.winner,
        source: row.source,
        sourceUpdateId: row.sourceUpdateId || undefined,
        sourceTimestamp: row.sourceTimestamp instanceof Date
            ? row.sourceTimestamp.toISOString()
            : new Date(row.sourceTimestamp).toISOString(),
        settledAt: row.settledAt instanceof Date
            ? row.settledAt.toISOString()
            : new Date(row.settledAt).toISOString(),
        raw: row.raw,
        createdAt: row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
        updatedAt: row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    };
}

export async function getOutcomeForFixture(fixtureId: string): Promise<Record<string, unknown>> {
    const outcome = await prismaAny.arenaOutcome.findUnique({
        where: { fixtureId },
    });
    if (!outcome || !isTrustedOutcomeSource(outcome.source)) {
        const error = new Error('txline_outcome_not_found');
        (error as any).statusCode = 404;
        throw error;
    }
    return serializeOutcome(outcome);
}

export async function listOutcomes(limit = 50): Promise<Record<string, unknown>> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const rows = await prismaAny.arenaOutcome.findMany({
        where: { source: { startsWith: 'txline' } },
        orderBy: [{ sourceTimestamp: 'desc' }, { updatedAt: 'desc' }],
        take: boundedLimit,
    });
    const trustedRows = rows.filter((row: any) => isTrustedOutcomeSource(row.source));
    return {
        count: trustedRows.length,
        outcomes: trustedRows.map(serializeOutcome),
    };
}

function normalizeSelection(selection: unknown): ArenaOutcomeWinner | null {
    const value = String(selection || '').trim().toLowerCase();
    if (value === 'part1' || value === 'home' || value === 'participant1') return 'part1';
    if (value === 'part2' || value === 'away' || value === 'participant2') return 'part2';
    if (value === 'draw' || value === 'x') return 'draw';
    return null;
}

function oneUnitPnl(signal: any, correct: boolean): number {
    const odds = Number(signal.oddsAfter ?? signal.oddsBefore ?? 2);
    const boundedOdds = Number.isFinite(odds) && odds > 1 ? odds : 2;
    if (signal.direction === 'SELL_SELECTION') {
        return correct ? 1 : Number(-(boundedOdds - 1).toFixed(6));
    }
    return correct ? Number((boundedOdds - 1).toFixed(6)) : -1;
}

export function evaluateSignalAgainstOutcome(signal: any, outcome: any): ArenaBacktestEvaluation {
    const signalTimestamp = signal.signalTimestamp instanceof Date
        ? signal.signalTimestamp
        : new Date(signal.signalTimestamp);
    const settledAt = outcome.settledAt instanceof Date
        ? outcome.settledAt
        : new Date(outcome.settledAt);
    const winner = normalizeSelection(outcome.winner);
    const selection = normalizeSelection(signal.selection);

    const base = {
        signalId: signal.id,
        fixtureId: signal.fixtureId,
        marketType: signal.marketType || undefined,
        selection: signal.selection || undefined,
        direction: signal.direction,
        oddsAfter: signal.oddsAfter ?? undefined,
        signalTimestamp: signalTimestamp.toISOString(),
        outcome: {
            winner: winner || outcome.winner,
            homeScore: outcome.homeScore,
            awayScore: outcome.awayScore,
            settledAt: settledAt.toISOString(),
        },
    };

    if (!Number.isFinite(signalTimestamp.getTime()) || !Number.isFinite(settledAt.getTime())) {
        return { ...base, correct: null, oneUnitPnl: null, skippedReason: 'invalid_timestamp' };
    }
    if (signalTimestamp.getTime() >= settledAt.getTime()) {
        return { ...base, correct: null, oneUnitPnl: null, skippedReason: 'signal_not_before_outcome' };
    }
    if (!winner || !selection) {
        return { ...base, correct: null, oneUnitPnl: null, skippedReason: 'unsupported_market_selection' };
    }

    const selectedWinner = selection === winner;
    const correct = signal.direction === 'SELL_SELECTION' ? !selectedWinner : selectedWinner;
    return {
        ...base,
        correct,
        oneUnitPnl: oneUnitPnl(signal, correct),
    };
}

function fixtureWhere(options: { fixtureId?: string; fixtureIds?: string[] }): Record<string, unknown> {
    if (options.fixtureId) return { fixtureId: options.fixtureId };
    const fixtureIds = [...new Set((options.fixtureIds || []).filter(Boolean))];
    if (fixtureIds.length > 0) return { fixtureId: { in: fixtureIds } };
    return {};
}

export async function runBacktest(options: { fixtureId?: string; fixtureIds?: string[]; minSampleSize?: number; limit?: number } = {}): Promise<Record<string, unknown>> {
    const minSampleSize = Math.min(Math.max(Math.floor(options.minSampleSize || 20), 1), 1000);
    const limit = Math.min(Math.max(Math.floor(options.limit || 10_000), 1), 50_000);
    const where = fixtureWhere(options);
    const [signals, outcomes] = await Promise.all([
        prismaAny.arenaStrategySignal.findMany({
            where,
            orderBy: [{ signalTimestamp: 'asc' }, { id: 'asc' }],
            take: limit,
        }),
        prismaAny.arenaOutcome.findMany({
            where,
        }),
    ]);
    const outcomeByFixture = new Map(outcomes.map((outcome: any) => [outcome.fixtureId, outcome]));
    const evaluations: ArenaBacktestEvaluation[] = signals.map((signal: any) => {
        const outcome = outcomeByFixture.get(signal.fixtureId);
        if (!outcome) {
            const signalTimestamp = signal.signalTimestamp instanceof Date
                ? signal.signalTimestamp.toISOString()
                : new Date(signal.signalTimestamp).toISOString();
            return {
                signalId: signal.id,
                fixtureId: signal.fixtureId,
                marketType: signal.marketType || undefined,
                selection: signal.selection || undefined,
                direction: signal.direction,
                oddsAfter: signal.oddsAfter ?? undefined,
                signalTimestamp,
                correct: null,
                oneUnitPnl: null,
                skippedReason: 'missing_final_outcome',
            } satisfies ArenaBacktestEvaluation;
        }
        return evaluateSignalAgainstOutcome(signal, outcome);
    });
    const evaluable = evaluations.filter((evaluation: ArenaBacktestEvaluation) => evaluation.correct !== null);
    const correct = evaluable.filter((evaluation: ArenaBacktestEvaluation) => evaluation.correct === true).length;
    const oneUnitPnl = evaluable.reduce((sum: number, evaluation: ArenaBacktestEvaluation) => sum + (evaluation.oneUnitPnl || 0), 0);
    const skippedCounts = evaluations.reduce((acc: Record<string, number>, evaluation: ArenaBacktestEvaluation) => {
        const reason = evaluation.skippedReason || 'evaluable';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
    }, {});

    return {
        day: 4,
        fixtureId: options.fixtureId || null,
        fixtureIds: options.fixtureIds || undefined,
        generatedAt: new Date().toISOString(),
        totalSignals: signals.length,
        storedOutcomes: outcomes.length,
        evaluableSignals: evaluable.length,
        correctSignals: correct,
        accuracy: evaluable.length > 0 ? correct / evaluable.length : null,
        oneUnitPnl: evaluable.length > 0 ? Number(oneUnitPnl.toFixed(6)) : null,
        minSampleSize,
        sampleSizeWarning: evaluable.length < minSampleSize ? 'insufficient_sample_for_profitability_claim' : null,
        verdict: evaluable.length >= minSampleSize
            ? 'backtest_sample_available'
            : 'cannot_honestly_prove_profitability_over_many_matches_yet',
        skippedCounts,
        evaluations: evaluations.slice(0, 250),
    };
}
