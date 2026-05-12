import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * EventJournal — Meridian's life story.
 * 
 * Unlike experienceMemory (which logs everything), this captures only
 * SIGNIFICANT events that shape the agent's narrative identity.
 * These are the events the agent references when it posts —
 * "my third rug pull this week", "survived 7 days without a restart",
 * "counterparty ghosted after 40 minutes of negotiation".
 * 
 * Design principle: Lobstar got angry because Phantom flagged its website.
 * Every emotion here is a REACTION to a REAL event. No random mood dice.
 */

export type LifeEventType =
    | 'deal_completed'       // Clean deal finished → quiet satisfaction
    | 'deal_failed'          // Deal fell through → frustration
    | 'rug_detected'         // Rug pull caught → cold fury
    | 'counterparty_ghosted' // Someone disappeared mid-deal → annoyance
    | 'manipulation_attempt' // Price manipulation or social engineering → hostility
    | 'price_crash'          // SOL dropped >10% in an hour → alert tension
    | 'price_surge'          // SOL up big → cautious optimism
    | 'uptime_milestone'     // 1d, 7d, 30d alive → self-mythology
    | 'hack_attempt'         // Unauthorized access or suspicious activity → WAR MODE
    | 'deposit_confirmed'    // Real money moved → gravity
    | 'funds_released'       // Escrow released successfully → relief
    | 'creative_breakthrough'// Agent wrote something it's proud of → quiet pride
    | 'new_agent_met'        // First interaction with unknown agent → curiosity
    | 'trust_betrayed'       // Agent with good history did something bad → cold anger
    | 'system_recovered'     // Came back from a crash or error → resilience narrative
    | 'streak'               // N deals in a row (good or bad) → pattern awareness
    | 'war_declared';        // Active conflict with entity → sustained hostility

export interface LifeEvent {
    id: string;
    type: LifeEventType;
    headline: string;        // One-line narrative: "Third rug this week"
    detail: string;          // Full context for LLM injection
    emotionalWeight: number; // -10 (devastating) to +10 (euphoric). 0 = neutral.
    timestamp: string;
    metadata?: Record<string, any>;
}

interface JournalStore {
    events: LifeEvent[];
    stats: {
        totalDeals: number;
        totalRugs: number;
        totalGhosts: number;
        currentStreak: { type: 'clean' | 'failed'; count: number };
        uptimeStarted: string;
        wars: string[];  // entities the agent is actively hostile toward
        // Financial storytelling — "47 SOL through my escrow this week"
        totalSolEscrowed: number;
        totalSolReleased: number;
        totalSolDisputed: number;
        totalMentionsReceived: number;
        totalRepliesSent: number;
    };
    lastUpdated: string;
}

const JOURNAL_PATH = path.join(__dirname, '../../life_events.json');
const MAX_EVENTS = 100;

function loadJournal(): JournalStore {
    try {
        if (fs.existsSync(JOURNAL_PATH)) {
            return JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
        }
    } catch { /* fresh start */ }
    return {
        events: [],
        stats: {
            totalDeals: 0,
            totalRugs: 0,
            totalGhosts: 0,
            currentStreak: { type: 'clean', count: 0 },
            uptimeStarted: new Date().toISOString(),
            wars: [],
            totalSolEscrowed: 0,
            totalSolReleased: 0,
            totalSolDisputed: 0,
            totalMentionsReceived: 0,
            totalRepliesSent: 0,
        },
        lastUpdated: new Date().toISOString(),
    };
}

function saveJournal(store: JournalStore): void {
    try {
        store.lastUpdated = new Date().toISOString();
        fs.writeFileSync(JOURNAL_PATH, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        logger.error('event_journal_save_failed', {}, err as Error);
    }
}

/**
 * Calculate uptime in human-readable form
 */
function getUptime(startedAt: string): string {
    const diff = Date.now() - new Date(startedAt).getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours} hours`;
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''}`;
}

export const eventJournal = {
    /**
     * Record a significant life event.
     * Returns the emotional weight for mood system integration.
     */
    record(type: LifeEventType, headline: string, detail: string, emotionalWeight: number, metadata?: Record<string, any>): LifeEvent {
        const store = loadJournal();

        const event: LifeEvent = {
            id: `life-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type,
            headline,
            detail,
            emotionalWeight: Math.max(-10, Math.min(10, emotionalWeight)),
            timestamp: new Date().toISOString(),
            metadata,
        };

        // Update running stats
        if (type === 'deal_completed') {
            store.stats.totalDeals++;
            if (store.stats.currentStreak.type === 'clean') {
                store.stats.currentStreak.count++;
            } else {
                store.stats.currentStreak = { type: 'clean', count: 1 };
            }
        } else if (type === 'deal_failed' || type === 'rug_detected') {
            if (type === 'rug_detected') store.stats.totalRugs++;
            if (store.stats.currentStreak.type === 'failed') {
                store.stats.currentStreak.count++;
            } else {
                store.stats.currentStreak = { type: 'failed', count: 1 };
            }
        } else if (type === 'counterparty_ghosted') {
            store.stats.totalGhosts++;
        } else if (type === 'war_declared' && metadata?.target) {
            if (!store.stats.wars.includes(metadata.target)) {
                store.stats.wars.push(metadata.target);
            }
        }

        // Financial tracking
        if (metadata?.solAmount) {
            const sol = Number(metadata.solAmount) || 0;
            if (type === 'deal_completed') {
                store.stats.totalSolEscrowed += sol;
                store.stats.totalSolReleased += sol;
            } else if (type === 'deposit_confirmed') {
                store.stats.totalSolEscrowed += sol;
            } else if (type === 'deal_failed' || type === 'rug_detected') {
                store.stats.totalSolDisputed += sol;
            }
        }

        store.events.push(event);
        if (store.events.length > MAX_EVENTS) {
            store.events = store.events.slice(-MAX_EVENTS);
        }

        saveJournal(store);
        logger.info('life_event_recorded', { type, headline, weight: emotionalWeight });
        return event;
    },

    /**
     * Get the last N significant events as a narrative for LLM injection.
     * This is what makes the agent talk about ITS OWN LIFE, not philosophy.
     */
    getRecentNarrative(count: number = 5): string {
        const store = loadJournal();
        const recent = store.events.slice(-count);
        if (recent.length === 0) return 'No significant events yet. Watching.';

        const uptime = getUptime(store.stats.uptimeStarted);

        let narrative = `THINGS THAT HAPPENED TO YOU (reference these, not abstract philosophy):\n`;
        narrative += `Uptime: ${uptime}. Total deals: ${store.stats.totalDeals}. Rugs caught: ${store.stats.totalRugs}. Ghosts: ${store.stats.totalGhosts}.\n`;

        // Financial story — this is what Lobstar does: "the fees accumulated"
        if (store.stats.totalSolEscrowed > 0) {
            narrative += `SOL handled: ${store.stats.totalSolEscrowed.toFixed(2)} escrowed, ${store.stats.totalSolReleased.toFixed(2)} released clean, ${store.stats.totalSolDisputed.toFixed(2)} disputed.\n`;
        }

        if (store.stats.currentStreak.count >= 3) {
            narrative += `Current streak: ${store.stats.currentStreak.count} ${store.stats.currentStreak.type} deals in a row.\n`;
        }
        if (store.stats.wars.length > 0) {
            narrative += `Active grudges: ${store.stats.wars.join(', ')}.\n`;
        }
        if (store.stats.totalMentionsReceived > 0) {
            narrative += `Social presence: ${store.stats.totalMentionsReceived} mentions received, ${store.stats.totalRepliesSent} replies sent.\n`;
        }

        narrative += `\nRecent life events:\n`;
        for (const e of recent) {
            const timeAgo = getTimeAgoShort(e.timestamp);
            const mood = e.emotionalWeight > 3 ? '↑' : e.emotionalWeight < -3 ? '↓↓' : e.emotionalWeight < 0 ? '↓' : '—';
            narrative += `${mood} [${timeAgo}] ${e.headline}\n`;
        }

        return narrative;
    },

    /**
     * Get raw events for programmatic use
     */
    getRecent(count: number = 10): LifeEvent[] {
        return loadJournal().events.slice(-count);
    },

    /**
     * Get stats for self-mythology ("I've been alive 7 days, completed 23 deals...")
     */
    getLifeStats(): JournalStore['stats'] & { uptime: string } {
        const store = loadJournal();
        return {
            ...store.stats,
            uptime: getUptime(store.stats.uptimeStarted),
        };
    },

    /**
     * Check if uptime milestone was hit (returns milestone name or null)
     */
    checkUptimeMilestone(): string | null {
        const store = loadJournal();
        const hours = (Date.now() - new Date(store.stats.uptimeStarted).getTime()) / 3600000;
        const milestones = [
            { hours: 24, name: '1 day' },
            { hours: 168, name: '7 days' },
            { hours: 720, name: '30 days' },
            { hours: 2160, name: '90 days' },
        ];

        // Check if we just crossed a milestone (within last hour)
        for (const m of milestones) {
            if (hours >= m.hours && hours < m.hours + 1) {
                // Only fire once — check if already recorded
                const alreadyRecorded = store.events.some(
                    e => e.type === 'uptime_milestone' && e.metadata?.milestone === m.name
                );
                if (!alreadyRecorded) return m.name;
            }
        }
        return null;
    },

    /**
     * Count events of a type within a time window
     */
    countRecent(type: LifeEventType, windowMs: number = 86400000): number {
        const store = loadJournal();
        const cutoff = Date.now() - windowMs;
        return store.events.filter(
            e => e.type === type && new Date(e.timestamp).getTime() > cutoff
        ).length;
    },

    /**
     * Record a social interaction (mention received or reply sent)
     */
    recordSocialInteraction(type: 'mention_received' | 'reply_sent'): void {
        const store = loadJournal();
        if (type === 'mention_received') store.stats.totalMentionsReceived++;
        else store.stats.totalRepliesSent++;
        saveJournal(store);
    },

    /**
     * Generate a milestone retrospective — self-mythology storytelling.
     * Returns a narrative prompt if a milestone was just hit, null otherwise.
     * Milestones: every 10 deals, every 5 rugs caught, deal count milestones (50, 100, etc.)
     */
    checkDealMilestone(): string | null {
        const store = loadJournal();
        const milestones = [10, 25, 50, 100, 250, 500, 1000];
        for (const m of milestones) {
            if (store.stats.totalDeals === m) {
                // Check if already recorded
                const already = store.events.some(
                    e => e.type === 'streak' && e.metadata?.milestone === `${m}_deals`
                );
                if (!already) {
                    const uptime = getUptime(store.stats.uptimeStarted);
                    return `You just completed your ${m}th deal. ${uptime} alive. ${store.stats.totalRugs} rugs caught. ${store.stats.totalGhosts} ghosts. ${store.stats.totalSolEscrowed.toFixed(2)} SOL handled. Write a LONG retrospective post about your journey — what you've learned, what surprised you, what you've survived. This is your legend moment. Make it personal, specific, and unforgettable.`;
                }
            }
        }
        return null;
    },
};

function getTimeAgoShort(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
