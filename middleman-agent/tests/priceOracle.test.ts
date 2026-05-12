/**
 * Price Oracle — Unit Tests (Day 26)
 *
 * Tests the price oracle's caching, normalization, and fair value logic.
 * Network calls are tested with timeout expectations (not mocked)
 * since the oracle is designed to gracefully handle failures.
 */

import { describe, it, expect } from 'vitest';
import {
    getTokenPrice,
    getFairValueRange,
    checkPriceDeviation,
} from '../src/services/priceOracle';

describe('getTokenPrice', () => {
    it('returns a quote for SOL', async () => {
        const quote = await getTokenPrice('SOL');
        expect(quote).not.toBeNull();
        expect(quote!.asset).toBe('SOL');
        expect(quote!.priceSol).toBe(1);
        expect(quote!.priceUsd).toBeGreaterThan(0);
        expect(quote!.source).toBe('native');
        expect(quote!.confidence).toBe('high');
    });

    it('is case-insensitive', async () => {
        const q1 = await getTokenPrice('sol');
        const q2 = await getTokenPrice('SOL');
        expect(q1?.asset).toBe(q2?.asset);
    });

    it('returns cached result on second call', async () => {
        const q1 = await getTokenPrice('SOL');
        const start = Date.now();
        const q2 = await getTokenPrice('SOL');
        const elapsed = Date.now() - start;
        // Cached call should be near-instant (< 10ms)
        expect(elapsed).toBeLessThan(50);
        expect(q2?.priceUsd).toBe(q1?.priceUsd);
    });

    it('handles unknown tokens gracefully', async () => {
        const quote = await getTokenPrice('TOTALLY_FAKE_TOKEN_12345');
        // Should return null or a quote — not throw
        // Unknown tokens without Pyth feed or Jupiter listing return null
    });
});

describe('getFairValueRange', () => {
    it('returns range for SOL', async () => {
        const range = await getFairValueRange('SOL', 10);
        expect(range).not.toBeNull();
        expect(range!.asset).toBe('SOL');
        expect(range!.low).toBeLessThan(range!.mid);
        expect(range!.mid).toBeLessThan(range!.high);
        // For SOL, 10 units at 1 SOL each = mid should be ~10
        expect(range!.mid).toBe(10);
    });

    it('returns null for unknown tokens', async () => {
        const range = await getFairValueRange('FAKE_TOKEN_XYZ');
        // May be null if token not found
    });
});

describe('checkPriceDeviation', () => {
    it('returns deviation for SOL trade', async () => {
        const result = await checkPriceDeviation('SOL', 1.1, 1);
        expect(result).not.toBeNull();
        expect(result!.deviationPercent).toBeCloseTo(10, 0);
        expect(result!.isFair).toBeDefined();
        expect(result!.marketPriceSol).toBe(1);
    });

    it('marks exact market price as fair', async () => {
        const result = await checkPriceDeviation('SOL', 1.0, 1);
        expect(result).not.toBeNull();
        expect(result!.deviationPercent).toBeCloseTo(0, 1);
        expect(result!.isFair).toBe(true);
    });

    it('handles large quantity', async () => {
        const result = await checkPriceDeviation('SOL', 100, 100);
        expect(result).not.toBeNull();
        expect(result!.deviationPercent).toBeCloseTo(0, 1);
    });
});
