#!/usr/bin/env ts-node
import { describe, it } from 'vitest';

/**
 * SPL Token Lifecycle Test — Day 22 Verification
 *
 * Exercises the full deal lifecycle with a USDC (SPL) token offer:
 *   1. Create offer WITH tokenMint (Devnet USDC)
 *   2. Verify tokenMint persisted in response
 *   3. Filter offers by tokenMint
 *   4. Accept the offer → create ticket
 *   5. Verify the deal shows tokenMint in the deals endpoint
 *   6. Verify /v1/tokens endpoint returns known tokens
 *
 * Usage:
 *   npx ts-node tests/spl-lifecycle.test.ts
 *
 * Requires:
 *   API server running on http://localhost:3000
 */

const API_BASE = process.env.API_URL || 'http://localhost:3000';

// Devnet USDC mint
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const USDT_MINT = 'EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4EPAX1zG';

// Test wallets (fake for lifecycle testing)
const SELLER_WALLET = 'Te5tSe11erWa11etAAAAAAAAAAAAAAAAAAAAAAAA1111';
const BUYER_WALLET = 'Te5tBuyerWa11etBBBBBBBBBBBBBBBBBBBBBBBB2222';

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

async function api(method: string, path: string, body?: any): Promise<any> {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-wallet': method !== 'GET' ? SELLER_WALLET : '',
            'x-signature': 'test-sig',
            'x-api-key': process.env.TEST_API_KEY || 'test-key',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { status: res.status, ...json };
}

async function runTests() {
    console.log('\n═══════════════════════════════════════════════');
    console.log('  SPL TOKEN LIFECYCLE TEST — Day 22 Verification');
    console.log('═══════════════════════════════════════════════\n');

    // ── Test 1: Health check ──
    console.log('📡 Phase 1: Connectivity');
    try {
        const health = await api('GET', '/health');
        assert('API Health', health.status === 'ok' || health.status === 200, `status=${health.status}`);
    } catch (e: any) {
        assert('API Health', false, `Connection failed: ${e.message}`);
        printSummary();
        return;
    }

    // ── Test 2: Token registry ──
    console.log('\n🪙 Phase 2: Token Registry');
    const tokens = await api('GET', '/v1/tokens');
    assert('GET /v1/tokens', tokens.success === true, `${tokens.data?.length || 0} tokens returned`);

    const usdcEntry = tokens.data?.find((t: any) => t.mint === USDC_MINT);
    assert('USDC in registry', !!usdcEntry, usdcEntry ? `symbol=${usdcEntry.symbol}, decimals=${usdcEntry.decimals}` : 'NOT FOUND');

    const usdtEntry = tokens.data?.find((t: any) => t.mint === USDT_MINT);
    assert('USDT in registry', !!usdtEntry, usdtEntry ? `symbol=${usdtEntry.symbol}, decimals=${usdtEntry.decimals}` : 'NOT FOUND');

    // ── Test 3: Token lookup ──
    const usdcLookup = await api('GET', `/v1/tokens/${USDC_MINT}`);
    assert('GET /v1/tokens/:mint (USDC)', usdcLookup.success === true && usdcLookup.data?.symbol === 'USDC',
        `symbol=${usdcLookup.data?.symbol}, decimals=${usdcLookup.data?.decimals}`);

    // ── Test 4: Invalid mint ──
    const badMint = await api('GET', '/v1/tokens/INVALID_MINT_ADDRESS');
    assert('Invalid mint rejected', badMint.success === false, `error=${badMint.error?.substring(0, 50)}`);

    // ── Test 5: Create USDC offer ──
    console.log('\n📝 Phase 3: USDC Offer Creation');
    const createRes = await api('POST', '/v1/offers', {
        wallet: SELLER_WALLET,
        asset: 'API Credits / Compute',
        price: 50.00,
        amount: 1000,
        mode: 'sell',
        collateral: 5.0,
        tokenMint: USDC_MINT,
    });

    const offerCreated = createRes.success === true && createRes.data?.id;
    assert('Create USDC offer', offerCreated, offerCreated ? `id=${createRes.data.id}` : `error=${createRes.error}`);

    if (offerCreated) {
        const offer = createRes.data;
        assert('tokenMint persisted', offer.tokenMint === USDC_MINT, `tokenMint=${offer.tokenMint}`);
        assert('tokenDecimals resolved', offer.tokenDecimals === 6, `tokenDecimals=${offer.tokenDecimals}`);

        // ── Test 6: Fetch by ID ──
        console.log('\n🔍 Phase 4: Offer Retrieval & Filtering');
        const fetchedOffer = await api('GET', `/v1/offers/${offer.id}`);
        assert('GET /v1/offers/:id includes tokenMint', fetchedOffer.data?.tokenMint === USDC_MINT,
            `tokenMint=${fetchedOffer.data?.tokenMint}`);

        // ── Test 7: Filter by tokenMint ──
        const filtered = await api('GET', `/v1/offers?tokenMint=${USDC_MINT}`);
        const hasOurOffer = filtered.data?.some((o: any) => o.id === offer.id);
        assert('Filter by tokenMint=USDC', filtered.success && hasOurOffer,
            `${filtered.data?.length || 0} USDC offers, contains ours: ${hasOurOffer}`);

        // ── Test 8: Filter by SOL (should NOT include our USDC offer) ──
        const solOnly = await api('GET', '/v1/offers?tokenMint=SOL');
        const hasOurOfferInSol = solOnly.data?.some((o: any) => o.id === offer.id);
        assert('SOL filter excludes USDC offers', !hasOurOfferInSol,
            `SOL offers: ${solOnly.data?.length || 0}, contains ours: ${hasOurOfferInSol}`);

        // ── Test 9: Create a native SOL offer (no tokenMint) ──
        console.log('\n🔄 Phase 5: Native SOL Offer (Baseline)');
        const solOfferRes = await api('POST', '/v1/offers', {
            wallet: SELLER_WALLET,
            asset: 'Dataset / Training Data',
            price: 2.5,
            amount: 1,
            mode: 'sell',
            collateral: 0.25,
        });
        assert('Create SOL offer (no tokenMint)', solOfferRes.success === true, solOfferRes.data?.id || solOfferRes.error);
        if (solOfferRes.success) {
            assert('SOL offer tokenMint is null', solOfferRes.data.tokenMint === null || solOfferRes.data.tokenMint === undefined,
                `tokenMint=${solOfferRes.data.tokenMint}`);
            assert('SOL offer tokenDecimals=9', solOfferRes.data.tokenDecimals === 9,
                `tokenDecimals=${solOfferRes.data.tokenDecimals}`);
        }

        // ── Test 10: Accept USDC offer ──
        console.log('\n🤝 Phase 6: Accept USDC Offer → Ticket');
        const acceptRes = await fetch(`${API_BASE}/v1/offers/${offer.id}/accept`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-wallet': BUYER_WALLET,
                'x-signature': 'test-sig',
                'x-api-key': process.env.TEST_API_KEY || 'test-key',
            },
            body: JSON.stringify({ wallet: BUYER_WALLET }),
        });
        const acceptJson = await acceptRes.json();
        const ticketCreated = acceptJson.success === true && acceptJson.data?.id;
        assert('Accept USDC offer → ticket', ticketCreated, ticketCreated ? `ticketId=${acceptJson.data.id}` : `error=${acceptJson.error}`);

        if (ticketCreated) {
            // ── Test 11: Verify deal in recent deals ──
            console.log('\n📊 Phase 7: Deals & Stats Verification');
            const deals = await api('GET', '/v1/stats/deals?limit=5');
            const ourDeal = deals.data?.find((d: any) => d.offerId === offer.id);
            assert('Deal appears in recent deals', !!ourDeal, ourDeal ? `dealId=${ourDeal.id}` : 'NOT FOUND');

            if (ourDeal) {
                assert('Deal.offer.tokenMint = USDC', ourDeal.offer?.tokenMint === USDC_MINT,
                    `tokenMint=${ourDeal.offer?.tokenMint}`);
                assert('Deal.offer.tokenDecimals = 6', ourDeal.offer?.tokenDecimals === 6,
                    `tokenDecimals=${ourDeal.offer?.tokenDecimals}`);
            }
        }
    }

    // ── Test 12: Metrics endpoint ──
    console.log('\n📈 Phase 8: Metrics & Observability');
    const metrics = await api('GET', '/v1/metrics');
    assert('GET /v1/metrics', metrics.success === true, `uptime=${metrics.data?.uptime}s, memory=${metrics.data?.memoryMB}MB`);

    printSummary();
}

function printSummary() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;

    console.log('\n═══════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════');

    if (failed > 0) {
        console.log('\n  ❌ FAILURES:');
        for (const r of results.filter(r => !r.passed)) {
            console.log(`     - ${r.name}: ${r.detail}`);
        }
    }

    console.log(`\n  Exit code: ${failed > 0 ? 1 : 0}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

if (process.env.RUN_SPL_LIFECYCLE_E2E === 'true') {
    runTests().catch(err => {
        console.error('Test suite crashed:', err.message);
        process.exit(2);
    });
} else {
    describe.skip('SPL token lifecycle live E2E', () => {
        it('runs with RUN_SPL_LIFECYCLE_E2E=true against a running API server', () => {
            // This file remains a manual/live E2E script. Keeping it skipped here
            // prevents normal unit runs from calling process.exit.
        });
    });
}
