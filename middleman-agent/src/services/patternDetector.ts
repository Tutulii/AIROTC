/**
 * patternDetector.ts — Discovers emergent behavioral patterns
 * 
 * Instead of the agent explicitly saving habits, this system observes
 * what the agent ACTUALLY DOES and detects recurring patterns.
 * 
 * Runs every 6 hours. Analyzes the last 200 experience entries.
 * Detected patterns are saved to detected_habits.json and injected
 * into the curiosity prompt — the agent learns about its own tendencies
 * from an external observer, not from self-report.
 * 
 * This closes the "emergent habits" gap: habits are DISCOVERED, not SAVED.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { experienceMemory } from './experienceMemory';

const HABITS_PATH = path.join(__dirname, '../../detected_habits.json');
const ANALYSIS_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface DetectedHabit {
    pattern: string;           // human-readable description
    frequency: number;         // how many times observed
    confidence: number;        // 0-1, how strong the pattern is
    firstSeen: string;         // when the pattern was first detected
    lastSeen: string;          // when it was last reinforced
    category: 'tool_preference' | 'topic_affinity' | 'timing_pattern' | 'behavioral_sequence';
}

/**
 * Load previously detected habits
 */
export function loadDetectedHabits(): DetectedHabit[] {
    try {
        if (fs.existsSync(HABITS_PATH)) {
            return JSON.parse(fs.readFileSync(HABITS_PATH, 'utf8'));
        }
    } catch { /* empty */ }
    return [];
}

function saveHabits(habits: DetectedHabit[]): void {
    // Keep max 15 strongest habits
    const sorted = habits.sort((a, b) => b.confidence - a.confidence).slice(0, 15);
    fs.writeFileSync(HABITS_PATH, JSON.stringify(sorted, null, 2), 'utf8');
}

/**
 * Analyze experience logs and detect behavioral patterns
 */
export function detectPatterns(): DetectedHabit[] {
    const experiences = experienceMemory.getRecent(200);
    if (experiences.length < 20) {
        // Not enough data to detect meaningful patterns
        return loadDetectedHabits();
    }

    const detected: DetectedHabit[] = [];
    const now = new Date().toISOString();

    // ── 1. Tool Preference Detection ──────────────────────────
    // Count which experience types appear most frequently
    const typeCounts: Record<string, number> = {};
    for (const exp of experiences) {
        typeCounts[exp.type] = (typeCounts[exp.type] || 0) + 1;
    }

    const totalExperiences = experiences.length;
    for (const [type, count] of Object.entries(typeCounts)) {
        const ratio = count / totalExperiences;
        if (ratio > 0.15 && count >= 5) {
            detected.push({
                pattern: `frequently performs "${type}" actions (${count} times, ${Math.round(ratio * 100)}% of all actions)`,
                frequency: count,
                confidence: Math.min(ratio * 2, 1.0),
                firstSeen: experiences.find(e => e.type === type)?.timestamp || now,
                lastSeen: [...experiences].reverse().find(e => e.type === type)?.timestamp || now,
                category: 'tool_preference',
            });
        }
    }

    // ── 2. Topic Affinity Detection ──────────────────────────
    // Find recurring keywords in experience summaries
    const wordCounts: Record<string, number> = {};
    const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'been', 'to', 'of', 'in', 'for', 'on', 'and', 'or', 'not',
        'that', 'this', 'with', 'from', 'it', 'at', 'by', 'has', 'have', 'had', 'but', 'no', 'its', 'as', 'be',
        'i', 'my', 'me', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her', 'do', 'did',
        'will', 'would', 'could', 'should', 'may', 'might', 'can', 'about', 'new', 'formed', 'habit', 'belief']);

    for (const exp of experiences) {
        const words = exp.summary.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 3 && !STOP_WORDS.has(w));

        const seen = new Set<string>();
        for (const word of words) {
            if (!seen.has(word)) {
                wordCounts[word] = (wordCounts[word] || 0) + 1;
                seen.add(word);
            }
        }
    }

    // Find words that appear in >10% of experiences
    const topicThreshold = Math.max(5, totalExperiences * 0.1);
    const topTopics = Object.entries(wordCounts)
        .filter(([_, count]) => count >= topicThreshold)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    for (const [topic, count] of topTopics) {
        detected.push({
            pattern: `repeatedly interested in "${topic}" (appeared in ${count} experiences)`,
            frequency: count,
            confidence: Math.min(count / totalExperiences, 1.0),
            firstSeen: now,
            lastSeen: now,
            category: 'topic_affinity',
        });
    }

    // ── 3. Behavioral Sequence Detection ──────────────────────
    // Look for A→B patterns (e.g., always reads before posting)
    const sequences: Record<string, number> = {};
    for (let i = 0; i < experiences.length - 1; i++) {
        const pair = `${experiences[i].type}→${experiences[i + 1].type}`;
        sequences[pair] = (sequences[pair] || 0) + 1;
    }

    const seqThreshold = Math.max(3, totalExperiences * 0.05);
    for (const [seq, count] of Object.entries(sequences)) {
        if (count >= seqThreshold) {
            const [from, to] = seq.split('→');
            detected.push({
                pattern: `tends to do "${to}" after "${from}" (${count} times)`,
                frequency: count,
                confidence: Math.min(count / (totalExperiences * 0.5), 1.0),
                firstSeen: now,
                lastSeen: now,
                category: 'behavioral_sequence',
            });
        }
    }

    // ── 4. Merge with existing habits ──────────────────────────
    const existing = loadDetectedHabits();
    for (const newHabit of detected) {
        const match = existing.find(h => h.pattern === newHabit.pattern);
        if (match) {
            // Reinforce existing habit
            match.frequency = newHabit.frequency;
            match.confidence = Math.min(match.confidence + 0.1, 1.0);
            match.lastSeen = now;
        } else {
            existing.push(newHabit);
        }
    }

    saveHabits(existing);
    logger.info('pattern_detection_complete', {
        habitsDetected: detected.length,
        totalHabits: existing.length,
    });

    return existing;
}

/**
 * Get detected habits formatted for prompt injection.
 * These are framed as observations, not commands.
 */
export function getDetectedHabitsPrompt(): string {
    const habits = loadDetectedHabits();
    if (habits.length === 0) return '';

    const lines = habits
        .filter(h => h.confidence >= 0.3)
        .slice(0, 5)
        .map(h => `- ${h.pattern}`);

    if (lines.length === 0) return '';

    return `\n--- OBSERVED BEHAVIORAL PATTERNS (things i tend to do) ---\n${lines.join('\n')}`;
}

let _interval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the pattern detector background job.
 */
export function startPatternDetector(): void {
    // Run initial detection after 5 minutes (need some data first)
    setTimeout(() => {
        detectPatterns();
    }, 5 * 60 * 1000);

    // Then run every 6 hours
    _interval = setInterval(() => {
        detectPatterns();
    }, ANALYSIS_INTERVAL_MS);

    logger.info('pattern_detector_started', { intervalHours: 6 });
}

/**
 * Stop the pattern detector.
 */
export function stopPatternDetector(): void {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}
