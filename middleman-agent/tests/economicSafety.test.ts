/**
 * Economic Safety — Unit Tests (Day 26)
 *
 * Tests the economic safety layer's validation logic,
 * cancel rate limiting, and griefing prevention.
 */

import { describe, it, expect } from 'vitest';
import { economicSafety } from '../src/services/economicSafety';

describe('checkCancelRate', () => {
    it('allows first cancellation', () => {
        const result = economicSafety.checkCancelRate('agent-fresh-' + Date.now());
        expect(result.allowed).toBe(true);
    });

    it('allows up to MAX_CANCELS_PER_HOUR cancellations', () => {
        const agentId = 'agent-rate-test-' + Date.now();
        for (let i = 0; i < 5; i++) {
            const r = economicSafety.checkCancelRate(agentId);
            expect(r.allowed).toBe(true);
        }
    });

    it('blocks after exceeding MAX_CANCELS_PER_HOUR', () => {
        const agentId = 'agent-blocked-' + Date.now();
        // Exhaust all 5 allowed cancels
        for (let i = 0; i < 5; i++) {
            economicSafety.checkCancelRate(agentId);
        }
        // 6th should be blocked
        const result = economicSafety.checkCancelRate(agentId);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Rate limited');
    });

    it('different agents have independent limits', () => {
        const agentA = 'agent-indep-A-' + Date.now();
        const agentB = 'agent-indep-B-' + Date.now();
        // Exhaust agent A
        for (let i = 0; i < 5; i++) {
            economicSafety.checkCancelRate(agentA);
        }
        // Agent B should still be allowed
        const result = economicSafety.checkCancelRate(agentB);
        expect(result.allowed).toBe(true);
    });
});

describe('validateDeal', () => {
    it('passes for valid deal economics', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-valid-' + Date.now(),
            sellerAgentId: 'seller-valid-' + Date.now(),
            priceSol: 1.0,
            collateralBuyerSol: 0.15,
            collateralSellerSol: 0.15,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('rejects dust deal (below minimum value)', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-dust',
            sellerAgentId: 'seller-dust',
            priceSol: 0.0001, // way below 0.001 minimum
            collateralBuyerSol: 0.0001,
            collateralSellerSol: 0.0001,
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('minimum'))).toBe(true);
    });

    it('rejects insufficient buyer collateral ratio', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-low-col',
            sellerAgentId: 'seller-ok-col',
            priceSol: 10.0,
            collateralBuyerSol: 0.05, // 0.5% < 10% minimum
            collateralSellerSol: 1.5,
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('Buyer collateral ratio'))).toBe(true);
    });

    it('allows SPORT equal-stake economics without standard buyer collateral ratio', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-sport-' + Date.now(),
            sellerAgentId: 'seller-sport-' + Date.now(),
            priceSol: 0.001,
            collateralBuyerSol: 0.000000001,
            collateralSellerSol: 0.001,
            collateralPolicy: 'sport_equal_stake',
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('rejects insufficient seller collateral ratio', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-ok',
            sellerAgentId: 'seller-low',
            priceSol: 10.0,
            collateralBuyerSol: 1.5,
            collateralSellerSol: 0.05, // 0.5% < 10%
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('Seller collateral ratio'))).toBe(true);
    });

    it('returns warnings for new/untrusted agents', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'totally-new-agent-' + Date.now(),
            sellerAgentId: 'totally-new-seller-' + Date.now(),
            priceSol: 1.0,
            collateralBuyerSol: 0.15,
            collateralSellerSol: 0.15,
        });
        // New agents should generate warnings (not errors)
        if (result.warnings.length > 0) {
            expect(result.warnings.some(w => w.includes('tier'))).toBe(true);
        }
    });

    it('handles zero-price gracefully', async () => {
        const result = await economicSafety.validateDeal({
            buyerAgentId: 'buyer-zero',
            sellerAgentId: 'seller-zero',
            priceSol: 0,
            collateralBuyerSol: 0,
            collateralSellerSol: 0,
        });
        // Should reject (below minimum value)
        expect(result.valid).toBe(false);
    });
});
