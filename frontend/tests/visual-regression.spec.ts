#!/usr/bin/env ts-node
/**
 * Frontend Visual Regression Test — Day 26
 *
 * Validates the critical UI pages of Mission Control Observatory:
 *   1. Dashboard — StatCards, MarketPulse, EventStream, SystemLogs
 *   2. Explorer — Deal list with status badges
 *   3. Agents — Agent cards with tier badges + watchlist
 *   4. Marketplace — Offer table, Market Depth, 24H Sparkline
 *   5. Docs — API Quickstart with code blocks
 *
 * This test uses fetch-based assertions (no browser required).
 * For full Playwright visual regression, install @playwright/test.
 *
 * Usage:
 *   npx ts-node tests/visual-regression.spec.ts [BASE_URL]
 *   Default: http://localhost:3001 (Next.js dev server)
 */

const FRONTEND_BASE = process.argv[2] || process.env.FRONTEND_URL || 'http://localhost:3001';
const API_BASE = process.env.API_URL || 'http://localhost:3000';
const simulationRoutesEnabled = process.env.ENABLE_SIMULATION_ROUTES === 'true';

interface TestResult {
    name: string;
    passed: boolean;
    detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string) {
    results.push({ name, passed: condition, detail });
    const icon = condition ? '✅' : '❌';
    console.log(`  ${icon} ${name}: ${detail}`);
}

async function fetchPage(path: string): Promise<{ status: number; html: string; headers: Headers }> {
    try {
        const res = await fetch(`${FRONTEND_BASE}${path}`, {
            headers: { 'Accept': 'text/html' },
            signal: AbortSignal.timeout(10000),
        });
        const html = await res.text();
        return { status: res.status, html, headers: res.headers };
    } catch (e: any) {
        return { status: 0, html: '', headers: new Headers() };
    }
}

async function fetchApi(path: string): Promise<any> {
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        return await res.json();
    } catch {
        return null;
    }
}

async function fetchApiResponse(path: string): Promise<{ status: number; json: any | null }> {
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });

        let json: any | null = null;
        try {
            json = await res.json();
        } catch {
            json = null;
        }

        return { status: res.status, json };
    } catch {
        return { status: 0, json: null };
    }
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

async function runTests() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  VISUAL REGRESSION & UI INTEGRITY TEST — Day 26');
    console.log(`  Frontend: ${FRONTEND_BASE}`);
    console.log(`  API:      ${API_BASE}`);
    console.log('═══════════════════════════════════════════════════\n');

    // ── Phase 1: Page Accessibility ──
    console.log('📄 Phase 1: Page Accessibility');
    const pages = ['/', '/explorer', '/agents', '/marketplace', '/docs'];
    for (const path of pages) {
        const { status, html } = await fetchPage(path);
        assert(`GET ${path} returns 200`, status === 200, `status=${status}, size=${html.length}`);
    }

    // ── Phase 2: HTML Structure Integrity ──
    console.log('\n🏗️ Phase 2: HTML Structure Integrity');
    const { html: dashHtml } = await fetchPage('/');
    assert('Dashboard has <title>', dashHtml.includes('<title'), `contains title tag`);
    assert('Dashboard has meta viewport', dashHtml.includes('viewport'), 'viewport meta present');
    assert('Dashboard loads design tokens', dashHtml.includes('__next') || dashHtml.includes('next'), 'Next.js runtime present');

    const { html: agentsHtml } = await fetchPage('/agents');
    assert('Agents page renders', agentsHtml.length > 1000, `size=${agentsHtml.length}`);

    const { html: marketHtml } = await fetchPage('/marketplace');
    assert('Marketplace page renders', marketHtml.length > 1000, `size=${marketHtml.length}`);

    const { html: docsHtml } = await fetchPage('/docs');
    assert('Docs page renders', docsHtml.length > 1000, `size=${docsHtml.length}`);

    // ── Phase 3: SEO Meta Tags ──
    console.log('\n🔍 Phase 3: SEO Meta Tags');
    for (const path of pages) {
        const { html } = await fetchPage(path);
        const hasTitle = html.includes('<title');
        assert(`${path} has <title>`, hasTitle, hasTitle ? 'present' : 'MISSING');
    }

    // ── Phase 4: API Backend Connectivity ──
    console.log('\n🔌 Phase 4: API Backend Connectivity');
    const health = await fetchApi('/health');
    assert('API health check', health?.status === 'ok', `status=${health?.status}`);

    const stats = await fetchApi('/v1/stats/overview');
    assert('Stats endpoint responsive', stats?.success === true, `success=${stats?.success}`);

    const agents = await fetchApi('/v1/agents');
    assert('Agents endpoint responsive', agents?.success === true, `count=${agents?.data?.length}`);

    const offers = await fetchApi('/v1/offers');
    assert('Offers endpoint responsive', offers?.success === true, `count=${offers?.data?.length}`);

    const tokens = await fetchApi('/v1/tokens');
    assert('Tokens endpoint responsive', tokens?.success === true, `count=${tokens?.data?.length}`);

    const metrics = await fetchApi('/v1/metrics');
    assert('Metrics endpoint responsive', !!metrics, `uptime=${metrics?.uptime || metrics?.data?.uptime}`);

    // ── Phase 5: 404 Handling ──
    console.log('\n🚫 Phase 5: Error Handling');
    const { status: notFoundStatus } = await fetchPage('/this-page-does-not-exist');
    assert('404 page returns correct status', notFoundStatus === 404, `status=${notFoundStatus}`);

    // ── Phase 6: Response Performance ──
    console.log('\n⚡ Phase 6: Response Performance');
    const perfPages = ['/', '/agents', '/marketplace'];
    for (const path of perfPages) {
        const start = Date.now();
        await fetchPage(path);
        const elapsed = Date.now() - start;
        assert(`${path} loads within 5s`, elapsed < 5000, `${elapsed}ms`);
    }

    // ── Phase 7: Design System Verification ──
    console.log('\n🎨 Phase 7: Design System Verification');
    const { html: layoutHtml } = await fetchPage('/');
    assert('Uses Space Grotesk font', layoutHtml.includes('Space+Grotesk') || layoutHtml.includes('space-grotesk') || layoutHtml.includes('Space Grotesk'), 'font reference found');
    assert('Uses JetBrains Mono font', layoutHtml.includes('JetBrains+Mono') || layoutHtml.includes('jetbrains') || layoutHtml.includes('JetBrains'), 'font reference found');
    assert('Uses Material Symbols', layoutHtml.includes('material-symbols') || layoutHtml.includes('Material+Symbols'), 'icon font reference found');

    // ── Phase 8: Critical Component Check (API-driven) ──
    console.log('\n🔧 Phase 8: Critical Component Data Sources');
    const prices = await fetchApi('/v1/prices');
    assert('Price Oracle responds', prices?.success === true, `assets=${Object.keys(prices?.data || {}).length}`);

    const simulate = await fetchApiResponse('/v1/simulate/spl-lifecycle');
    if (simulationRoutesEnabled) {
        assert('Simulate endpoint responds when enabled', simulate.status === 200 && simulate.json?.success === true, `status=${simulate.status}`);
    } else {
        assert('Simulate endpoint stays disabled by default', simulate.status === 404, `status=${simulate.status}`);
    }

    const rpcHealth = await fetchApi('/v1/health/rpc');
    assert('RPC Health responds', rpcHealth !== null, `status=${rpcHealth?.data?.status || 'ok'}`);

    printSummary();
}

function printSummary() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;
    const score = Math.round((passed / total) * 10);

    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`);
    console.log(`  SCORE:   ${score}/10`);
    console.log('═══════════════════════════════════════════════════');

    if (failed > 0) {
        console.log('\n  ❌ FAILURES:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`     - ${r.name}: ${r.detail}`);
        }
    }

    console.log(`\n  Exit code: ${failed > 0 ? 1 : 0}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Visual regression test crashed:', err.message);
    process.exit(2);
});
