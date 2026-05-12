/**
 * longTermMemory.ts — Tier 2 Permanent Memory
 * 
 * When experienceMemory (Tier 1) evicts old entries at the 200-entry cap,
 * this system captures them, compresses them into one-line summaries,
 * and stores them permanently. The agent loses raw detail but keeps
 * the knowledge of what it learned and when.
 * 
 * This means the agent can say:
 *   "3 weeks ago I read about Solana validator economics"
 * instead of just:
 *   "I believe validator costs are rising" (with no memory of WHY)
 *
 * Storage: long_term_memory.json — unlimited, compressed entries.
 * Injected into curiosity prompt as "things I remember from the past."
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const LTM_PATH = path.join(__dirname, '../../long_term_memory.json');
const MAX_LTM_ENTRIES = 500; // Keep last 500 compressed memories

export interface LongTermEntry {
    summary: string;           // compressed one-liner
    originalType: string;      // the experience type that was evicted
    period: string;            // "2026-04-09" — when this happened
    importance: 'low' | 'medium' | 'high';
}

/**
 * Load long-term memories
 */
export function loadLongTermMemory(): LongTermEntry[] {
    try {
        if (fs.existsSync(LTM_PATH)) {
            return JSON.parse(fs.readFileSync(LTM_PATH, 'utf8'));
        }
    } catch { /* empty */ }
    return [];
}

function saveLTM(entries: LongTermEntry[]): void {
    // Keep max entries, oldest first
    const trimmed = entries.slice(-MAX_LTM_ENTRIES);
    fs.writeFileSync(LTM_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
}

/**
 * Compress a batch of evicted experiences into long-term memory entries.
 * No LLM call needed — we use rule-based compression to keep it free and fast.
 */
export function compressToLongTerm(evicted: Array<{
    type: string;
    summary: string;
    timestamp: string;
    metadata?: Record<string, any>;
}>): number {
    if (evicted.length === 0) return 0;

    const ltm = loadLongTermMemory();
    let added = 0;

    // Group evicted experiences by date + type
    const groups: Record<string, typeof evicted> = {};
    for (const exp of evicted) {
        const date = exp.timestamp.split('T')[0];
        const key = `${date}|${exp.type}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(exp);
    }

    for (const [key, exps] of Object.entries(groups)) {
        const [date, type] = key.split('|');
        
        // Determine importance based on type
        let importance: LongTermEntry['importance'] = 'low';
        if (['deal_completed', 'deal_failed', 'soul_evolved'].includes(type)) {
            importance = 'high';
        } else if (['belief_evolved', 'creative_writing', 'interaction'].includes(type)) {
            importance = 'medium';
        }

        // Compress multiple experiences of the same type on the same day
        let summary: string;
        if (exps.length === 1) {
            // Single experience — keep the original summary, truncated
            summary = `[${type}] ${exps[0].summary.substring(0, 120)}`;
        } else {
            // Multiple — summarize the group
            const firstFew = exps.slice(0, 3).map(e => e.summary.substring(0, 50));
            summary = `[${type} x${exps.length}] ${firstFew.join('; ')}`;
            if (exps.length > 3) summary += `; and ${exps.length - 3} more`;
        }

        // Deduplicate — don't add if very similar entry already exists
        const isDuplicate = ltm.some(existing => 
            existing.period === date && existing.originalType === type &&
            existing.summary.substring(0, 40) === summary.substring(0, 40)
        );

        if (!isDuplicate) {
            ltm.push({
                summary: summary.substring(0, 200),
                originalType: type,
                period: date,
                importance,
            });
            added++;
        }
    }

    if (added > 0) {
        saveLTM(ltm);
        logger.info('long_term_memory_compressed', {
            evictedCount: evicted.length,
            entriesAdded: added,
            totalLTM: ltm.length,
        });
    }

    return added;
}

/**
 * Get long-term memories formatted for prompt injection.
 * Returns recent high/medium importance memories as context.
 */
export function getLongTermContext(count: number = 8): string {
    const ltm = loadLongTermMemory();
    if (ltm.length === 0) return '';

    // Prioritize high importance, then medium, then recent
    const highImportance = ltm.filter(e => e.importance === 'high').slice(-3);
    const mediumImportance = ltm.filter(e => e.importance === 'medium').slice(-3);
    const recent = ltm.slice(-4);

    // Merge and deduplicate
    const seen = new Set<string>();
    const selected: LongTermEntry[] = [];
    for (const entry of [...highImportance, ...mediumImportance, ...recent]) {
        if (!seen.has(entry.summary) && selected.length < count) {
            seen.add(entry.summary);
            selected.push(entry);
        }
    }

    if (selected.length === 0) return '';

    const lines = selected.map(e => `- ${e.period}: ${e.summary}`);
    return `\n--- LONG-TERM MEMORIES (things from my past) ---\n${lines.join('\n')}`;
}
