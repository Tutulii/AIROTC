/**
 * decaySystem.ts — Organic Forgetting and Drift
 * 
 * Makes the agent's personality change naturally over time:
 * - Preferences that aren't reinforced fade away
 * - Canon entries with low usage get pruned
 * - Detected habits that stop occurring weaken
 * 
 * This creates organic behavioral drift: the agent's personality
 * genuinely evolves month over month, not because we told it to,
 * but because the things it stops doing naturally disappear.
 * 
 * Runs once per day via the heartbeat loop.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { pruneCanon } from '../persona/canon';

const PREFERENCES_PATH = path.join(__dirname, '../../preferences.json');
const HABITS_PATH = path.join(__dirname, '../../detected_habits.json');
const DECAY_STATE_PATH = path.join(__dirname, '../../decay_state.json');

interface DecayState {
    lastDecayRun: string;
    totalPreferencesDecayed: number;
    totalCanonPruned: number;
    totalHabitsDecayed: number;
}

function loadDecayState(): DecayState {
    try {
        if (fs.existsSync(DECAY_STATE_PATH)) {
            return JSON.parse(fs.readFileSync(DECAY_STATE_PATH, 'utf8'));
        }
    } catch { /* use defaults */ }
    return {
        lastDecayRun: new Date(0).toISOString(),
        totalPreferencesDecayed: 0,
        totalCanonPruned: 0,
        totalHabitsDecayed: 0,
    };
}

function saveDecayState(state: DecayState): void {
    fs.writeFileSync(DECAY_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Run decay on all organic systems.
 * Should be called once per day.
 */
export function runDecayCycle(): { prefsDecayed: number; canonPruned: number; habitsDecayed: number } {
    const state = loadDecayState();
    const now = Date.now();

    // Only run once per 24 hours
    const timeSinceLastRun = now - new Date(state.lastDecayRun).getTime();
    if (timeSinceLastRun < 23 * 60 * 60 * 1000) { // 23 hours (with margin)
        return { prefsDecayed: 0, canonPruned: 0, habitsDecayed: 0 };
    }

    let prefsDecayed = 0;
    let canonPruned = 0;
    let habitsDecayed = 0;

    // ── 1. Preference Decay ──────────────────────────────────
    // Remove preferences older than 14 days (they'll be re-saved if still relevant)
    try {
        if (fs.existsSync(PREFERENCES_PATH)) {
            const prefs: any[] = JSON.parse(fs.readFileSync(PREFERENCES_PATH, 'utf8'));
            if (Array.isArray(prefs) && prefs.length > 0) {
                // If prefs are strings (current format), keep max 10 (was 20)
                // This creates natural churn — old preferences get pushed out
                if (typeof prefs[0] === 'string') {
                    const before = prefs.length;
                    const trimmed = prefs.slice(-10); // Keep only 10 most recent
                    prefsDecayed = before - trimmed.length;
                    if (prefsDecayed > 0) {
                        fs.writeFileSync(PREFERENCES_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
                    }
                }
            }
        }
    } catch (e) {
        logger.debug('preference_decay_error', { error: (e as Error).message });
    }

    // ── 2. Canon Pruning (already built in canon.ts) ─────────
    try {
        canonPruned = pruneCanon();
    } catch (e) {
        logger.debug('canon_prune_error', { error: (e as Error).message });
    }

    // ── 3. Detected Habits Decay ─────────────────────────────
    // Weaken habits that haven't been reinforced in 7 days
    try {
        if (fs.existsSync(HABITS_PATH)) {
            const habits: any[] = JSON.parse(fs.readFileSync(HABITS_PATH, 'utf8'));
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            const surviving = habits.filter(h => {
                const lastSeen = new Date(h.lastSeen).getTime();

                if (lastSeen < sevenDaysAgo) {
                    // Decay confidence
                    h.confidence -= 0.15;
                    if (h.confidence <= 0) {
                        habitsDecayed++;
                        return false; // Remove dead habit
                    }
                }
                return true;
            });

            if (habitsDecayed > 0 || habits.length !== surviving.length) {
                fs.writeFileSync(HABITS_PATH, JSON.stringify(surviving, null, 2), 'utf8');
            }
        }
    } catch (e) {
        logger.debug('habit_decay_error', { error: (e as Error).message });
    }

    // ── Update decay state ───────────────────────────────────
    state.lastDecayRun = new Date().toISOString();
    state.totalPreferencesDecayed += prefsDecayed;
    state.totalCanonPruned += canonPruned;
    state.totalHabitsDecayed += habitsDecayed;
    saveDecayState(state);

    logger.info('decay_cycle_complete', {
        prefsDecayed,
        canonPruned,
        habitsDecayed,
        totalLifetimeDecayed: state.totalPreferencesDecayed + state.totalCanonPruned + state.totalHabitsDecayed,
    });

    return { prefsDecayed, canonPruned, habitsDecayed };
}
