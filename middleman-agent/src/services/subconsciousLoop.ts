/**
 * subconsciousLoop.ts — Meridian's Fast Attention Scanner
 * 
 * This is the "subconscious" — a lightweight, fast-firing loop that runs
 * every 15-30 seconds, scanning for interesting events. When it detects
 * something worth thinking about, it triggers an immediate full curiosity cycle.
 * 
 * This closes the "impulse" gap: the agent notices things in near-real-time
 * and reacts within seconds, not minutes. From the outside, this is
 * indistinguishable from genuine impulse.
 * 
 * Uses llmModelFast (cheap, fast) — single-step, no tools, just attention.
 */

import OpenAI from 'openai';
import { loadConfig } from '../config';
import { logger } from '../utils/logger';
import { experienceMemory } from './experienceMemory';
import { soulEngine } from './soulEngine';
import { eventBus } from './eventBus';

let _client: OpenAI | null = null;
let _interval: ReturnType<typeof setInterval> | null = null;
let _running = false;

function getClient(): OpenAI {
    if (!_client) {
        const config = loadConfig();
        _client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
    }
    return _client;
}

interface AttentionSignal {
    source: string;
    content: string;
    timestamp: string;
}

/**
 * Gather recent signals from all sources
 */
function gatherSignals(): AttentionSignal[] {
    const signals: AttentionSignal[] = [];

    // Latest experiences (last 3)
    const recent = experienceMemory.getRecent(3);
    for (const exp of recent) {
        // Only include very recent experiences (last 2 minutes)
        const age = Date.now() - new Date(exp.timestamp).getTime();
        if (age < 120_000) {
            signals.push({
                source: exp.type,
                content: exp.summary.substring(0, 100),
                timestamp: exp.timestamp,
            });
        }
    }

    // Current mood
    const moodScore = soulEngine.getMood ? soulEngine.getMood() : 0;
    const mood = moodScore > 30 ? 'elevated' : moodScore < -30 ? 'agitated' : 'neutral';
    if (Math.abs(moodScore) > 40) {
        signals.push({
            source: 'mood',
            content: `mood is ${mood} (score: ${moodScore})`,
            timestamp: new Date().toISOString(),
        });
    }

    return signals;
}

/**
 * Run one attention scan.
 * Returns true if the subconscious determined something is worth a full think.
 */
async function scan(): Promise<boolean> {
    if (_running) return false; // skip if previous scan still running
    _running = true;

    try {
        const signals = gatherSignals();

        // If nothing happened recently, don't even call the LLM — save money
        if (signals.length === 0) {
            return false;
        }

        const config = loadConfig();
        const client = getClient();

        const signalText = signals.map(s => `[${s.source}] ${s.content}`).join('\n');

        const res = await client.chat.completions.create({
            model: config.llmModelFast || config.llmModel,
            temperature: 0.3,
            max_tokens: 50,
            messages: [
                {
                    role: 'system',
                    content: `you are a fast attention scanner for an autonomous agent. you see recent events and decide: is this worth a full thought cycle? respond with ONLY "interesting" or "boring". say "interesting" only if something genuinely surprising, alarming, or thought-provoking happened. routine events are "boring".`
                },
                {
                    role: 'user',
                    content: `recent signals:\n${signalText}\n\nverdict (one word):`
                }
            ],
        });

        const verdict = (res.choices[0]?.message?.content || '').trim().toLowerCase();
        const isInteresting = verdict.includes('interesting');

        if (isInteresting) {
            logger.info('subconscious_triggered', {
                signalCount: signals.length,
                signals: signals.map(s => s.source),
            });

            // Record the impulse
            experienceMemory.record('observation',
                `subconscious noticed something: ${signals[0]?.content}`,
                { source: 'subconscious_loop', triggered: true }
            );
        }

        return isInteresting;
    } catch (e: any) {
        logger.debug('subconscious_scan_error', { error: e.message });
        return false;
    } finally {
        _running = false;
    }
}

/**
 * Start the subconscious loop.
 * Runs every 20 seconds. When something interesting is detected,
 * emits 'trigger_curiosity_now' on the eventBus.
 */
export function startSubconsciousLoop(): void {
    const SCAN_INTERVAL_MS = 20_000; // 20 seconds

    logger.info('subconscious_loop_started', { intervalMs: SCAN_INTERVAL_MS });

    _interval = setInterval(async () => {
        const shouldThink = await scan();
        if (shouldThink) {
            eventBus.publish('trigger_curiosity_now', {
                reason: 'subconscious_attention',
                timestamp: new Date().toISOString(),
            });
        }
    }, SCAN_INTERVAL_MS);
}

/**
 * Stop the subconscious loop.
 */
export function stopSubconsciousLoop(): void {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        logger.info('subconscious_loop_stopped');
    }
}
