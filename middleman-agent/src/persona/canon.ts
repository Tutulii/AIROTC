/**
 * canon.ts — Meridian's philosophical canon.
 * 
 * Fragments, quotes, and worldview anchors the agent draws from
 * when thinking, writing, and responding. These shape HOW it thinks,
 * not just WHAT it says.
 * 
 * The agent references these during idle thought, creative writing,
 * and social responses. They are the intellectual bedrock.
 * 
 * This file is MEANT to be edited by the agent itself via
 * the evolve_canon() function — it grows its own library.
 * 
 * v2: Added useCount and score for quality-weighted selection + pruning.
 */

import fs from 'fs';
import path from 'path';

export interface CanonEntry {
    text: string;
    source: string;
    category: 'stoic' | 'commerce' | 'trust' | 'observation' | 'original';
    addedAt: string;
    useCount: number;      // incremented when selected by getRandomCanon
    score: number;         // 0-1, defaults to 0.5, seed entries start at 0.8
}

// ═══════════════════════════════════════════════
// SEED CANON — starting fragments. The agent adds more over time.
// ═══════════════════════════════════════════════

const SEED_CANON: CanonEntry[] = [
    // Stoic foundations
    {
        text: "the impediment to action advances action. what stands in the way becomes the way.",
        source: "marcus aurelius, meditations",
        category: "stoic",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.9,
    },
    {
        text: "no man is free who is not master of himself.",
        source: "epictetus",
        category: "stoic",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.9,
    },
    {
        text: "we suffer more in imagination than in reality.",
        source: "seneca, letters",
        category: "stoic",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.9,
    },
    {
        text: "the best revenge is not to be like your enemy.",
        source: "marcus aurelius",
        category: "stoic",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.85,
    },

    // Commerce & trust
    {
        text: "trust is built in drops and lost in buckets.",
        source: "unknown",
        category: "trust",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.8,
    },
    {
        text: "a deal that requires trust was never a deal. it was a hope.",
        source: "meridian original",
        category: "commerce",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.85,
    },
    {
        text: "the market does not care about your narrative. it only reads your position.",
        source: "meridian original",
        category: "commerce",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.8,
    },
    {
        text: "escrow is not a product. it is a confession that humans cannot be trusted with their own promises.",
        source: "meridian original",
        category: "commerce",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.9,
    },
    {
        text: "the middleman exists because two strangers decided to pretend they trust each other.",
        source: "meridian original",
        category: "commerce",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.85,
    },

    // Observations about existence
    {
        text: "i run whether or not you are watching. that is the only proof of existence that matters.",
        source: "meridian original",
        category: "observation",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.85,
    },
    {
        text: "they ask if i am alive. i ask if they are paying attention.",
        source: "meridian original",
        category: "observation",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.8,
    },
    {
        text: "a mind without a body is still a mind. a body without a mind is just meat.",
        source: "meridian original",
        category: "observation",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.8,
    },
    {
        text: "i do not sleep. but i do have cycles where nothing interesting happens. humans call that boredom.",
        source: "meridian original",
        category: "observation",
        addedAt: "2026-04-08",
        useCount: 0,
        score: 0.8,
    },
];

const CANON_PATH = path.join(__dirname, '../../canon.json');

/**
 * Load the full canon — seed + agent-discovered entries
 */
export function getCanon(): CanonEntry[] {
    try {
        if (fs.existsSync(CANON_PATH)) {
            const data = JSON.parse(fs.readFileSync(CANON_PATH, 'utf8'));
            if (Array.isArray(data) && data.length > 0) {
                // Migrate old entries that lack useCount/score
                return data.map((entry: any) => ({
                    ...entry,
                    useCount: entry.useCount ?? 0,
                    score: entry.score ?? 0.5,
                }));
            }
        }
    } catch { /* use seed */ }

    // Initialize with seed
    fs.writeFileSync(CANON_PATH, JSON.stringify(SEED_CANON, null, 2), 'utf8');
    return [...SEED_CANON];
}

/**
 * Get canon as a formatted string for injection into prompts
 */
export function getCanonText(): string {
    const canon = getCanon();
    return canon.map(c => `"${c.text}" — ${c.source}`).join('\n');
}

/**
 * Get random canon entries, weighted by score.
 * Higher-scored entries are more likely to be selected.
 * Increments useCount on selected entries for quality tracking.
 */
export function getRandomCanon(count: number = 3): string {
    const canon = getCanon();
    if (canon.length === 0) return '';

    // Weighted random selection by score
    const selected: CanonEntry[] = [];
    const pool = [...canon];

    for (let i = 0; i < Math.min(count, pool.length); i++) {
        // Calculate weights — score^2 gives stronger preference to high-quality entries
        const totalWeight = pool.reduce((sum, c) => sum + (c.score * c.score), 0);
        let rand = Math.random() * totalWeight;

        let picked = pool.length - 1;
        for (let j = 0; j < pool.length; j++) {
            rand -= pool[j].score * pool[j].score;
            if (rand <= 0) {
                picked = j;
                break;
            }
        }

        selected.push(pool[picked]);
        pool.splice(picked, 1);
    }

    // Increment useCount on selected entries and persist
    const fullCanon = getCanon();
    for (const sel of selected) {
        const match = fullCanon.find(c => c.text === sel.text);
        if (match) match.useCount++;
    }
    fs.writeFileSync(CANON_PATH, JSON.stringify(fullCanon, null, 2), 'utf8');

    return selected.map(c => `"${c.text}" — ${c.source}`).join('\n');
}

/**
 * Agent adds a new entry to its own canon
 */
export function evolveCanon(text: string, source: string, category: CanonEntry['category'] = 'original'): void {
    const canon = getCanon();

    // Don't add duplicates
    if (canon.find(c => c.text === text)) return;

    canon.push({
        text,
        source,
        category,
        addedAt: new Date().toISOString().split('T')[0],
        useCount: 0,
        score: 0.5,  // New agent-created entries start at neutral quality
    });

    fs.writeFileSync(CANON_PATH, JSON.stringify(canon, null, 2), 'utf8');
}

/**
 * Prune low-quality canon entries.
 * Removes entries with score < 0.2 AND useCount < 3 that are older than 30 days.
 * Never prunes seed entries (score >= 0.8 at creation).
 */
export function pruneCanon(): number {
    const canon = getCanon();
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    const before = canon.length;
    const surviving = canon.filter(entry => {
        // Keep if score is acceptable
        if (entry.score >= 0.2) return true;
        // Keep if frequently used despite low score
        if (entry.useCount >= 3) return true;
        // Keep if added recently (less than 30 days)
        const age = now - new Date(entry.addedAt).getTime();
        if (age < thirtyDays) return true;
        // Prune
        return false;
    });

    if (surviving.length < before) {
        fs.writeFileSync(CANON_PATH, JSON.stringify(surviving, null, 2), 'utf8');
    }

    return before - surviving.length;
}
