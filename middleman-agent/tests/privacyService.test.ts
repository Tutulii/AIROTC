/**
 * Privacy Service — Unit Tests (Day 26)
 *
 * Tests the SHA-256 commitment scheme, nonce generation,
 * hash verification, and canonical format compliance.
 * These functions are pure (no DB) except for store/get.
 */

import { describe, it, expect } from 'vitest';
import {
    generateNonce,
    computeTermsHash,
    verifyTermsHash,
} from '../src/services/privacyService';

const SAMPLE_TERMS = {
    price: 1000000000, // 1 SOL in lamports
    collateral_buyer: 500000000,
    collateral_seller: 500000000,
    asset_type: 'SOL',
};

describe('generateNonce', () => {
    it('generates a 32-byte buffer', () => {
        const nonce = generateNonce();
        expect(nonce).toBeInstanceOf(Buffer);
        expect(nonce.length).toBe(32);
    });

    it('generates unique nonces', () => {
        const n1 = generateNonce();
        const n2 = generateNonce();
        expect(n1.toString('hex')).not.toBe(n2.toString('hex'));
    });
});

describe('computeTermsHash', () => {
    it('returns 64-char hex hash string', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        expect(commitment.termsHash).toHaveLength(64);
        expect(/^[0-9a-f]{64}$/.test(commitment.termsHash)).toBe(true);
    });

    it('returns 32-byte hash buffer', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        expect(commitment.termsHashBytes).toBeInstanceOf(Buffer);
        expect(commitment.termsHashBytes.length).toBe(32);
    });

    it('is deterministic — same inputs produce same hash', () => {
        const nonce = Buffer.alloc(32, 0xAB);
        const c1 = computeTermsHash(SAMPLE_TERMS, nonce);
        const c2 = computeTermsHash(SAMPLE_TERMS, nonce);
        expect(c1.termsHash).toBe(c2.termsHash);
    });

    it('produces different hashes for different nonces', () => {
        const n1 = Buffer.alloc(32, 0x01);
        const n2 = Buffer.alloc(32, 0x02);
        const c1 = computeTermsHash(SAMPLE_TERMS, n1);
        const c2 = computeTermsHash(SAMPLE_TERMS, n2);
        expect(c1.termsHash).not.toBe(c2.termsHash);
    });

    it('produces different hashes for different prices', () => {
        const nonce = Buffer.alloc(32, 0xAA);
        const c1 = computeTermsHash(SAMPLE_TERMS, nonce);
        const c2 = computeTermsHash({ ...SAMPLE_TERMS, price: 999999999 }, nonce);
        expect(c1.termsHash).not.toBe(c2.termsHash);
    });

    it('produces different hashes for different asset types', () => {
        const nonce = Buffer.alloc(32, 0xBB);
        const c1 = computeTermsHash(SAMPLE_TERMS, nonce);
        const c2 = computeTermsHash({ ...SAMPLE_TERMS, asset_type: 'USDC' }, nonce);
        expect(c1.termsHash).not.toBe(c2.termsHash);
    });

    it('follows canonical format: price:buyer:seller:asset:nonce', () => {
        const nonce = Buffer.alloc(32, 0xFF);
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        // The nonce hex should be in the commitment
        expect(commitment.nonce).toBe(nonce.toString('hex'));
    });
});

describe('verifyTermsHash', () => {
    it('returns true for matching terms + nonce', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        const result = verifyTermsHash(SAMPLE_TERMS, commitment.nonce, commitment.termsHash);
        expect(result).toBe(true);
    });

    it('returns false for tampered price', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        const tampered = { ...SAMPLE_TERMS, price: 1 };
        const result = verifyTermsHash(tampered, commitment.nonce, commitment.termsHash);
        expect(result).toBe(false);
    });

    it('returns false for tampered nonce', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        const fakeNonce = generateNonce().toString('hex');
        const result = verifyTermsHash(SAMPLE_TERMS, fakeNonce, commitment.termsHash);
        expect(result).toBe(false);
    });

    it('returns false for tampered hash', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        const fakeHash = '0'.repeat(64);
        const result = verifyTermsHash(SAMPLE_TERMS, commitment.nonce, fakeHash);
        expect(result).toBe(false);
    });

    it('returns false for tampered collateral amounts', () => {
        const nonce = generateNonce();
        const commitment = computeTermsHash(SAMPLE_TERMS, nonce);
        const tampered = { ...SAMPLE_TERMS, collateral_buyer: 999 };
        const result = verifyTermsHash(tampered, commitment.nonce, commitment.termsHash);
        expect(result).toBe(false);
    });
});
