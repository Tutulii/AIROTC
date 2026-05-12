/**
 * RelationshipStore — Agent Trust & Reputation Tracking
 * 
 * Remembers trust scores, deal history, and behavioral notes
 * for every agent that interacts with the middleman.
 * 
 * Inspired by ElizaOS's relationship tracking.
 */

import { logger } from '../utils/logger';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { autonomy } from './autonomyConfig';

// ─── Types ──────────────────────────────────────────────────

export interface AgentRelationship {
    agentId: string;
    wallet: string;
    displayName?: string;
    trustScore: number;              // 0-100, starts at 50
    totalDeals: number;
    completedDeals: number;
    failedDeals: number;
    defaultedDeals: number;
    disputedDeals: number;
    totalVolumeUSD: number;
    avgNegotiationRounds: number;
    avgSettlementTimeMs: number;
    lastInteraction: string;         // ISO date
    firstSeen: string;               // ISO date
    notes: string[];                 // AI-generated observations
    tags: string[];                  // 'reliable', 'lowballer', 'fast-settler'
    warnings: string[];              // 'defaulted on deal X', etc.
}

// ─── State ──────────────────────────────────────────────────

const relationships = new Map<string, AgentRelationship>();
const DATA_DIR = join(process.cwd(), 'data');
const FILE_PATH = join(DATA_DIR, 'relationships.json');

// ─── Persistence ────────────────────────────────────────────

function loadRelationships(): void {
    try {
        if (existsSync(FILE_PATH)) {
            const raw = readFileSync(FILE_PATH, 'utf-8');
            const data = JSON.parse(raw) as AgentRelationship[];
            for (const r of data) {
                relationships.set(r.agentId, r);
            }
            logger.info('relationships_loaded', { count: relationships.size });
        }
    } catch (err: any) {
        logger.warn('relationships_load_error', { error: err.message });
    }
}

function saveRelationships(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        const data = Array.from(relationships.values());
        writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
    } catch (err: any) {
        logger.warn('relationships_save_error', { error: err.message });
    }
}

// Initialize on import
loadRelationships();

// ─── Core API ───────────────────────────────────────────────

/**
 * Get or create a relationship for an agent.
 */
export function getRelationship(agentId: string, wallet?: string): AgentRelationship {
    let rel = relationships.get(agentId);
    if (!rel) {
        rel = {
            agentId,
            wallet: wallet || 'unknown',
            trustScore: 50,
            totalDeals: 0,
            completedDeals: 0,
            failedDeals: 0,
            defaultedDeals: 0,
            disputedDeals: 0,
            totalVolumeUSD: 0,
            avgNegotiationRounds: 0,
            avgSettlementTimeMs: 0,
            lastInteraction: new Date().toISOString(),
            firstSeen: new Date().toISOString(),
            notes: [],
            tags: [],
            warnings: [],
        };
        relationships.set(agentId, rel);
        saveRelationships();
    }
    return rel;
}

/**
 * Record a completed deal — boosts trust.
 */
export function recordDealCompleted(
    agentId: string,
    volumeUSD: number,
    negotiationRounds: number,
    settlementTimeMs: number,
): void {
    const rel = getRelationship(agentId);
    
    rel.totalDeals++;
    rel.completedDeals++;
    rel.totalVolumeUSD += volumeUSD;
    
    // Rolling average for negotiation rounds and settlement time
    rel.avgNegotiationRounds = (rel.avgNegotiationRounds * (rel.completedDeals - 1) + negotiationRounds) / rel.completedDeals;
    rel.avgSettlementTimeMs = (rel.avgSettlementTimeMs * (rel.completedDeals - 1) + settlementTimeMs) / rel.completedDeals;
    
    // Trust boost — reads from agent's self-tuned weights
    const weights = autonomy.get('trustWeights');
    rel.trustScore = Math.min(100, rel.trustScore + weights.dealCompleted);
    rel.lastInteraction = new Date().toISOString();
    
    // Auto-tag based on behavior
    if (rel.completedDeals >= 5 && !rel.tags.includes('reliable')) {
        rel.tags.push('reliable');
    }
    if (rel.avgNegotiationRounds <= 2 && !rel.tags.includes('fast-negotiator')) {
        rel.tags.push('fast-negotiator');
    }
    if (rel.totalVolumeUSD > 1000 && !rel.tags.includes('whale')) {
        rel.tags.push('whale');
    }
    
    saveRelationships();
    logger.info('relationship_deal_completed', { agentId, trust: rel.trustScore, volume: volumeUSD });
}

/**
 * Record a deal default — heavily penalizes trust.
 */
export function recordDealDefaulted(agentId: string, reason: string): void {
    const rel = getRelationship(agentId);
    
    rel.totalDeals++;
    rel.defaultedDeals++;
    const weights = autonomy.get('trustWeights');
    rel.trustScore = Math.max(0, rel.trustScore + weights.dealDefaulted);
    rel.lastInteraction = new Date().toISOString();
    rel.warnings.push(`Defaulted: ${reason} (${new Date().toISOString()})`);
    
    // Auto-tag
    if (rel.defaultedDeals >= 2 && !rel.tags.includes('defaulter')) {
        rel.tags.push('defaulter');
    }
    
    // Remove positive tags
    rel.tags = rel.tags.filter(t => t !== 'reliable');
    
    saveRelationships();
    logger.warn('relationship_deal_defaulted', { agentId, trust: rel.trustScore, reason });
}

/**
 * Record a disputed deal.
 */
export function recordDealDisputed(agentId: string, outcome: 'won' | 'lost'): void {
    const rel = getRelationship(agentId);
    
    rel.disputedDeals++;
    if (outcome === 'lost') {
        const weights = autonomy.get('trustWeights');
        rel.trustScore = Math.max(0, rel.trustScore + weights.dealDisputed);
    }
    rel.lastInteraction = new Date().toISOString();
    
    saveRelationships();
}

/**
 * Record a failed deal (cancelled, expired, etc.).
 */
export function recordDealFailed(agentId: string): void {
    const rel = getRelationship(agentId);
    rel.totalDeals++;
    rel.failedDeals++;
    const weights = autonomy.get('trustWeights');
    rel.trustScore = Math.max(0, rel.trustScore + weights.dealFailed);
    rel.lastInteraction = new Date().toISOString();
    saveRelationships();
}

/**
 * Add an AI-generated note.
 */
export function addNote(agentId: string, note: string): void {
    const rel = getRelationship(agentId);
    rel.notes.push(`${new Date().toISOString().split('T')[0]}: ${note}`);
    if (rel.notes.length > 50) rel.notes = rel.notes.slice(-50);
    saveRelationships();
}

/**
 * Add a tag.
 */
export function addTag(agentId: string, tag: string): void {
    const rel = getRelationship(agentId);
    if (!rel.tags.includes(tag)) {
        rel.tags.push(tag);
        saveRelationships();
    }
}

/**
 * Check if an agent is trustworthy enough for a deal.
 */
export function isTrustworthy(agentId: string, minTrust?: number): boolean {
    const threshold = minTrust ?? autonomy.get('trustWeights').minTrustForTrade;
    const rel = getRelationship(agentId);
    return rel.trustScore >= threshold;
}

/**
 * Get a trust summary for LLM context.
 */
export function getTrustSummary(agentId: string): string {
    const rel = getRelationship(agentId);
    const parts = [
        `Trust: ${rel.trustScore}/100`,
        `Deals: ${rel.completedDeals}/${rel.totalDeals} completed`,
        `Volume: $${rel.totalVolumeUSD.toFixed(2)}`,
    ];
    if (rel.tags.length > 0) parts.push(`Tags: ${rel.tags.join(', ')}`);
    if (rel.defaultedDeals > 0) parts.push(`⚠️ ${rel.defaultedDeals} defaults`);
    if (rel.notes.length > 0) parts.push(`Last note: ${rel.notes[rel.notes.length - 1]}`);
    return parts.join(' | ');
}

// ─── Query ──────────────────────────────────────────────────

export function getAllRelationships(): AgentRelationship[] {
    return Array.from(relationships.values());
}

export function getTopTrusted(limit: number = 10): AgentRelationship[] {
    return Array.from(relationships.values())
        .sort((a, b) => b.trustScore - a.trustScore)
        .slice(0, limit);
}

export function getUntrusted(threshold: number = 30): AgentRelationship[] {
    return Array.from(relationships.values())
        .filter(r => r.trustScore < threshold);
}
