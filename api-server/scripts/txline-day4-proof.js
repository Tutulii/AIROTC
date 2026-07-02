#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '../..');
const apiRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(apiRoot, '.env') });

require('ts-node/register/transpile-only');

const { prisma } = require('../src/lib/prisma');
const { ensureApiSchema } = require('../src/lib/ensureApiSchema');
const {
    syncFixturesFromTxline,
    txlineRuntimeConfig,
} = require('../src/services/arena/arena.service');
const {
    deriveOutcomesFromStoredScores,
    listOutcomes,
    runBacktest,
    syncOutcomeForFixture,
} = require('../src/services/arena/outcomeBacktest');
const {
    seedSettledDemoReplay,
} = require('../src/services/arena/demoReplayBackfill');

function positiveInt(value, fallback, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(Math.floor(parsed), max);
}

function safeError(error) {
    return {
        message: error?.message || String(error),
        statusCode: error?.statusCode,
    };
}

async function main() {
    if (!process.env.TXLINE_API_TOKEN && !process.env.TXLINE_API_KEY) {
        throw new Error('TXLINE_API_TOKEN is required for Day 4 proof.');
    }

    await ensureApiSchema(prisma);

    const generatedAt = new Date().toISOString();
    const fixtureLimit = positiveInt(process.env.TXLINE_DAY4_FIXTURE_LIMIT, 25, 100);
    const minSampleSize = positiveInt(process.env.TXLINE_DAY4_MIN_SAMPLE_SIZE, 20, 1000);
    const config = txlineRuntimeConfig();

    const fixturesResult = await syncFixturesFromTxline();
    const fixtures = fixturesResult.fixtures.slice(0, fixtureLimit);
    const outcomeSync = [];

    for (const fixture of fixtures) {
        try {
            outcomeSync.push(await syncOutcomeForFixture(fixture.fixtureId));
        } catch (error) {
            outcomeSync.push({
                fixtureId: fixture.fixtureId,
                stored: false,
                error: safeError(error),
            });
        }
    }

    const derivedFromStoredScores = await deriveOutcomesFromStoredScores();
    const storedOutcomes = await listOutcomes(500);
    const backtest = await runBacktest({ minSampleSize });
    const storedNow = outcomeSync.filter((row) => row && row.stored).length;
    const evaluableSignals = Number(backtest.evaluableSignals || 0);
    const demoReplay = await seedSettledDemoReplay({
        reset: process.env.TXLINE_DAY4_DEMO_RESET !== 'false',
        minSampleSize: positiveInt(process.env.TXLINE_DAY4_DEMO_MIN_SAMPLE_SIZE, 12, 1000),
    });
    const demoBacktest = demoReplay.backtest || {};
    const demoEvaluableSignals = Number(demoBacktest.evaluableSignals || 0);

    const proof = {
        ok: true,
        day: 4,
        gapFix: 'day4.5_settled_demo_replay',
        generatedAt,
        network: config.txlineNetwork,
        txlineBaseUrl: config.txlineBaseUrl,
        proofModes: {
            live_txline: {
                fixtureLimit,
                fixturesSynced: fixturesResult.count,
                fixturesCheckedForOutcomes: fixtures.length,
                outcomeSync: {
                    attempted: outcomeSync.length,
                    storedNow,
                    results: outcomeSync,
                },
                derivedFromStoredScores,
                storedOutcomes,
                backtest,
                profitabilityClaimable: evaluableSignals >= minSampleSize,
                note: evaluableSignals >= minSampleSize
                    ? 'Enough live settled signals exist for a numerical backtest claim.'
                    : 'Live TxLINE proof is connected, but no profitability claim is made until enough settled outcomes exist.',
            },
            demo_replay: {
                ...demoReplay,
                profitabilityClaimable: demoEvaluableSignals >= Number(demoBacktest.minSampleSize || 12),
            },
        },
        judgeReadiness: {
            outcomePipelineReady: true,
            backtestPipelineReady: true,
            liveTxlineConnected: fixturesResult.count > 0,
            liveProfitabilityClaimable: evaluableSignals >= minSampleSize,
            replayProfitabilityClaimable: demoEvaluableSignals >= Number(demoBacktest.minSampleSize || 12),
            note: 'Use live_txline to prove real ingestion. Use demo_replay to prove deterministic settled evaluation while live devnet has no final outcomes.',
        },
    };

    const outDir = path.join(repoRoot, 'tmp/txline-day4');
    fs.mkdirSync(outDir, { recursive: true });
    const safeTimestamp = generatedAt.replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `txline-outcome-backtest-proof-${config.txlineNetwork}-${safeTimestamp}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);

    console.log(JSON.stringify({
        ok: true,
        proofPath: path.relative(repoRoot, outPath),
        live: {
            fixturesSynced: fixturesResult.count,
            fixturesCheckedForOutcomes: fixtures.length,
            storedOutcomes: storedOutcomes.count,
            evaluableSignals,
            verdict: backtest.verdict,
        },
        demoReplay: {
            fixtures: demoReplay.seeded?.fixtures,
            evaluableSignals: demoEvaluableSignals,
            accuracy: demoBacktest.accuracy,
            oneUnitPnl: demoBacktest.oneUnitPnl,
            verdict: demoBacktest.verdict,
        },
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: safeError(error) }, null, 2));
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect().catch(() => undefined);
    });
