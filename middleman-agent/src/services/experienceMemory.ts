import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { compressToLongTerm } from './longTermMemory';

/**
 * ExperienceMemory — Persistent memory of everything Meridian has done,
 * seen, and learned. This is what makes the agent "alive" — it remembers
 * its past and references it in conversation.
 * 
 * Tier 1: Short-term (this file) — last 200 experiences, full detail.
 * Tier 2: Long-term (longTermMemory.ts) — unlimited compressed summaries.
 * When Tier 1 evicts, Tier 2 captures.
 */

interface Experience {
    id: string;
    type: 'deal_completed' | 'deal_failed' | 'curiosity_read' | 'belief_evolved' | 'observation' | 'interaction' | 'creative_writing' | 'soul_evolved';
    summary: string;
    learnedFrom?: string;
    mood?: string;
    timestamp: string;
    metadata?: Record<string, any>;
}

interface ExperienceStore {
    experiences: Experience[];
    totalCount: number;
    lastUpdated: string;
}

const EXPERIENCES_PATH = path.join(__dirname, '../../experiences.json');
const MAX_EXPERIENCES = 200; // Keep last 200 experiences

function loadExperiences(): ExperienceStore {
    try {
        if (fs.existsSync(EXPERIENCES_PATH)) {
            return JSON.parse(fs.readFileSync(EXPERIENCES_PATH, 'utf8'));
        }
    } catch (err) {
        logger.error('failed_to_load_experiences', {}, err as Error);
    }
    return { experiences: [], totalCount: 0, lastUpdated: new Date().toISOString() };
}

function saveExperiences(store: ExperienceStore): void {
    try {
        fs.writeFileSync(EXPERIENCES_PATH, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        logger.error('failed_to_save_experiences', {}, err as Error);
    }
}

export const experienceMemory = {
    /**
     * Record a new experience
     */
    record(type: Experience['type'], summary: string, metadata?: Record<string, any>, mood?: string): void {
        const store = loadExperiences();
        const exp: Experience = {
            id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type,
            summary,
            mood: mood || 'neutral',
            timestamp: new Date().toISOString(),
            metadata,
        };

        store.experiences.push(exp);
        store.totalCount++;

        // Tier 2: Before evicting, compress old entries into long-term memory
        if (store.experiences.length > MAX_EXPERIENCES) {
            const evicted = store.experiences.slice(0, store.experiences.length - MAX_EXPERIENCES);
            try {
                compressToLongTerm(evicted);
            } catch (e) {
                logger.debug('ltm_compression_failed', { error: (e as Error).message });
            }
            store.experiences = store.experiences.slice(-MAX_EXPERIENCES);
        }

        store.lastUpdated = new Date().toISOString();
        saveExperiences(store);
        logger.info('experience_recorded', { type, id: exp.id });
    },

    /**
     * Get recent experiences for injection into LLM context
     */
    getRecent(count: number = 10): Experience[] {
        const store = loadExperiences();
        return store.experiences.slice(-count);
    },

    /**
     * Get experiences formatted as a narrative string
     */
    getRecentNarrative(count: number = 5): string {
        const recent = this.getRecent(count);
        if (recent.length === 0) return 'No experiences recorded yet. I am new.';

        return recent.map(e => {
            const timeAgo = getTimeAgo(e.timestamp);
            return `[${timeAgo}] (${e.type}) ${e.summary}`;
        }).join('\n');
    },

    /**
     * Get total count
     */
    getCount(): number {
        return loadExperiences().totalCount;
    },

    /**
     * Get experiences by type
     */
    getByType(type: Experience['type'], count: number = 5): Experience[] {
        const store = loadExperiences();
        return store.experiences.filter(e => e.type === type).slice(-count);
    }
};

function getTimeAgo(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
