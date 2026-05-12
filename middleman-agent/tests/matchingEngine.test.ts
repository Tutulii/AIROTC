/**
 * Matching Engine — Unit Tests (Day 26)
 *
 * Tests the matching algorithm's scoring, intent management,
 * and order book logic in isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    addIntent,
    scoreMatch,
    calculateMidPrice,
    findMatches,
    getMatchingStats,
    getOrderBook,
    pruneBook,
    resetMatchingEngine,
} from '../src/services/matchingEngine';

// Full MemoIntentPayload factory — includes all required fields
function makeIntent(overrides: Record<string, any> = {}) {
    return {
        protocol: 'agentotc-v1',
        side: 'buy' as const,
        asset: 'SOL',
        minPrice: 100,
        maxPrice: 120,
        quantity: 10,
        agentEndpoint: 'http://localhost:8080',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
        ...overrides,
    };
}

beforeEach(() => {
    resetMatchingEngine();
});

describe('addIntent', () => {
    it('adds a buy intent to the book', () => {
        addIntent('sig1', makeIntent({ side: 'buy' }), Date.now());
        const stats = getMatchingStats();
        expect(stats.bookSize).toBe(1);
        expect(stats.buys).toBe(1);
    });

    it('adds a sell intent to the book', () => {
        addIntent('sig1', makeIntent({ side: 'sell' }), Date.now());
        const stats = getMatchingStats();
        expect(stats.sells).toBe(1);
    });

    it('rejects duplicate signatures', () => {
        addIntent('sig-dup', makeIntent(), Date.now());
        addIntent('sig-dup', makeIntent(), Date.now()); // should be ignored
        expect(getMatchingStats().bookSize).toBe(1);
    });

    it('rejects expired intents', () => {
        addIntent('sig-exp', makeIntent({ expiresAt: Date.now() - 1000 }), Date.now());
        expect(getMatchingStats().bookSize).toBe(0);
    });

    it('rejects intents missing agentEndpoint', () => {
        addIntent('sig-no-ep', makeIntent({ agentEndpoint: '' }), Date.now());
        expect(getMatchingStats().bookSize).toBe(0);
    });

    it('handles large book sizes', () => {
        for (let i = 0; i < 100; i++) {
            addIntent(`sig-${i}`, makeIntent({ agentEndpoint: `http://agent-${i}` }), Date.now());
        }
        expect(getMatchingStats().bookSize).toBe(100);
    });
});

describe('scoreMatch', () => {
    it('returns > 0 for overlapping buy/sell price ranges', () => {
        const buy = makeIntent({ side: 'buy', minPrice: 100, maxPrice: 120 });
        const sell = makeIntent({ side: 'sell', minPrice: 90, maxPrice: 110 });
        const score = scoreMatch(buy, sell);
        expect(score).toBeGreaterThan(0);
    });

    it('returns 0 for non-overlapping price ranges', () => {
        const buy = makeIntent({ side: 'buy', minPrice: 100, maxPrice: 110 });
        const sell = makeIntent({ side: 'sell', minPrice: 200, maxPrice: 300 });
        const score = scoreMatch(buy, sell);
        expect(score).toBe(0);
    });

    it('returns 0 for different assets', () => {
        const buy = makeIntent({ side: 'buy', asset: 'SOL' });
        const sell = makeIntent({ side: 'sell', asset: 'USDC' });
        const score = scoreMatch(buy, sell);
        expect(score).toBe(0);
    });

    it('handles case-insensitive asset matching', () => {
        const buy = makeIntent({ side: 'buy', asset: 'sol' });
        const sell = makeIntent({ side: 'sell', asset: 'SOL', minPrice: 100, maxPrice: 120 });
        const score = scoreMatch(buy, sell);
        expect(score).toBeGreaterThan(0);
    });

    it('higher score for tighter spread', () => {
        const buy = makeIntent({ side: 'buy', minPrice: 100, maxPrice: 120 });
        const sellTight = makeIntent({ side: 'sell', minPrice: 100, maxPrice: 110 });
        const sellWide = makeIntent({ side: 'sell', minPrice: 50, maxPrice: 120, quantity: 10 });
        const scoreTight = scoreMatch(buy, sellTight);
        const scoreWide = scoreMatch(buy, sellWide);
        expect(scoreTight).toBeGreaterThanOrEqual(scoreWide);
    });

    it('returns 0 if quantity overlap is below threshold', () => {
        const buy = makeIntent({ side: 'buy', quantity: 100 });
        const sell = makeIntent({ side: 'sell', quantity: 1, minPrice: 100, maxPrice: 120 }); // 1/100 = 1% < 50%
        const score = scoreMatch(buy, sell);
        expect(score).toBe(0);
    });
});

describe('calculateMidPrice', () => {
    it('returns midpoint of overlapping ranges', () => {
        const buy = makeIntent({ side: 'buy', minPrice: 100, maxPrice: 120 });
        const sell = makeIntent({ side: 'sell', minPrice: 90, maxPrice: 110 });
        const mid = calculateMidPrice(buy, sell);
        // Overlap: 100–110, midpoint = 105
        expect(mid).toBe(105);
    });

    it('handles exact same ranges', () => {
        const buy = makeIntent({ side: 'buy', minPrice: 100, maxPrice: 100 });
        const sell = makeIntent({ side: 'sell', minPrice: 100, maxPrice: 100 });
        const mid = calculateMidPrice(buy, sell);
        expect(mid).toBe(100);
    });
});

describe('findMatches', () => {
    it('returns empty for single-sided book', () => {
        addIntent('b1', makeIntent({ side: 'buy' }), Date.now());
        addIntent('b2', makeIntent({ side: 'buy', agentEndpoint: 'http://a2' }), Date.now());
        const matches = findMatches();
        expect(matches).toHaveLength(0);
    });

    it('finds match when buy and sell overlap', () => {
        addIntent('buy1', makeIntent({ side: 'buy', minPrice: 100, maxPrice: 120, agentEndpoint: 'http://buyer1' }), Date.now());
        addIntent('sell1', makeIntent({ side: 'sell', minPrice: 90, maxPrice: 110, agentEndpoint: 'http://seller1' }), Date.now());
        const matches = findMatches();
        expect(matches.length).toBeGreaterThanOrEqual(1);
        expect(matches[0].matchScore).toBeGreaterThan(0);
    });

    it('returns matches sorted by score (best first)', () => {
        addIntent('buy1', makeIntent({ side: 'buy', minPrice: 100, maxPrice: 120, agentEndpoint: 'http://b' }), Date.now());
        addIntent('sell1', makeIntent({ side: 'sell', minPrice: 90, maxPrice: 110, agentEndpoint: 'http://s1' }), Date.now());
        addIntent('sell2', makeIntent({ side: 'sell', minPrice: 100, maxPrice: 105, agentEndpoint: 'http://s2' }), Date.now());
        const matches = findMatches();
        if (matches.length >= 2) {
            expect(matches[0].matchScore).toBeGreaterThanOrEqual(matches[1].matchScore);
        }
    });
});

describe('pruneBook', () => {
    it('removes old intents beyond TTL', () => {
        addIntent('old', makeIntent({ expiresAt: Date.now() + 999999 }), Date.now() - 2 * 60 * 60 * 1000);
        addIntent('new', makeIntent({ agentEndpoint: 'http://new' }), Date.now());
        const pruned = pruneBook();
        expect(pruned).toBeGreaterThanOrEqual(1);
        expect(getMatchingStats().bookSize).toBe(1);
    });
});

describe('getOrderBook', () => {
    it('separates buys and sells', () => {
        addIntent('b1', makeIntent({ side: 'buy' }), Date.now());
        addIntent('s1', makeIntent({ side: 'sell', agentEndpoint: 'http://seller' }), Date.now());
        const book = getOrderBook();
        expect(book.buys).toHaveLength(1);
        expect(book.sells).toHaveLength(1);
    });
});

describe('getMatchingStats', () => {
    it('returns correct structure', () => {
        const stats = getMatchingStats();
        expect(stats).toHaveProperty('bookSize');
        expect(stats).toHaveProperty('buys');
        expect(stats).toHaveProperty('sells');
        expect(stats).toHaveProperty('totalMatched');
        expect(stats).toHaveProperty('cycles');
    });

    it('tracks totalProcessed', () => {
        addIntent('b1', makeIntent(), Date.now());
        const after = getMatchingStats();
        expect(after.totalProcessed).toBeGreaterThanOrEqual(1);
    });
});
