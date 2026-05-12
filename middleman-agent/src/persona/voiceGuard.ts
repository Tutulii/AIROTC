/**
 * voiceGuard.ts — Runtime enforcement layer for Meridian's voice rules.
 *
 * voice.ts defines what the agent SHOULD sound like.
 * voiceGuard.ts enforces it AFTER the LLM generates output.
 *
 * Every outbound text (tweets, soul writes, replies, quotes)
 * passes through voiceGuard() before reaching the outside world.
 */

import { VOICE } from './voice';
import { logger } from '../utils/logger';

export interface VoiceGuardResult {
    passes: boolean;
    violations: string[];
    cleaned: string;
}

/**
 * Check text against all voice rules. Returns violations and a cleaned version.
 */
export function voiceGuard(text: string): VoiceGuardResult {
    const violations: string[] = [];
    let cleaned = text;

    // 1. Check banned phrases (case-insensitive)
    for (const phrase of VOICE.bannedPhrases) {
        const regex = new RegExp(escapeRegex(phrase), 'gi');
        if (regex.test(cleaned)) {
            violations.push(`banned phrase: "${phrase}"`);
            cleaned = cleaned.replace(regex, '').trim();
        }
    }

    // 2. Check banned patterns (regex-based)
    for (const pattern of VOICE.bannedPatterns) {
        try {
            const regex = new RegExp(pattern, 'gi');
            if (regex.test(cleaned)) {
                violations.push(`banned pattern: /${pattern}/`);
                cleaned = cleaned.replace(regex, '').trim();
            }
        } catch { /* skip invalid regex */ }
    }

    // 3. Exclamation mark check
    if (cleaned.includes('!')) {
        violations.push('contains exclamation mark');
        cleaned = cleaned.replace(/!/g, '.');
    }

    // 4. Emoji check (Unicode emoji ranges)
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu;
    if (emojiRegex.test(cleaned)) {
        violations.push('contains emoji');
        cleaned = cleaned.replace(emojiRegex, '').trim();
    }

    // 5. Hashtag check
    if (/#\w+/.test(cleaned)) {
        violations.push('contains hashtag');
        cleaned = cleaned.replace(/#\w+/g, '').trim();
    }

    // 6. Uppercase check — flag if more than 30% uppercase (allows quoted proper nouns)
    const letters = cleaned.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 10) {
        const upperRatio = (letters.replace(/[^A-Z]/g, '').length) / letters.length;
        if (upperRatio > 0.3) {
            violations.push(`excessive capitalization (${Math.round(upperRatio * 100)}%)`);
            cleaned = cleaned.toLowerCase();
        }
    }

    // 7. Clean up artifacts from removals (double spaces, trailing commas)
    cleaned = cleaned
        .replace(/\s{2,}/g, ' ')
        .replace(/^\s*,\s*/, '')
        .replace(/\s*,\s*$/, '')
        .replace(/\.\s*\./g, '.')
        .trim();

    // If cleaning emptied the string, that means the entire output was violations
    if (cleaned.length === 0 && text.length > 0) {
        cleaned = '[voice guard: entire output violated rules]';
    }

    if (violations.length > 0) {
        logger.info('voice_guard_violations', {
            count: violations.length,
            violations: violations.slice(0, 5),
            originalLength: text.length,
            cleanedLength: cleaned.length,
        });
    }

    return {
        passes: violations.length === 0,
        violations,
        cleaned,
    };
}

/**
 * Quick pass/fail check without cleaning.
 */
export function voiceCheck(text: string): boolean {
    return voiceGuard(text).passes;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
