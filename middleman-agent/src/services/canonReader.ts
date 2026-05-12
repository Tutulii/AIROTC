/**
 * Canon Reader — Meridian's Intellectual Library
 *
 * Reads Canon.md from the project root and serves random philosophical
 * fragments for injection into LLM prompts. This gives Meridian an
 * inner intellectual life — references it can draw from when forming
 * thoughts and coloring its communication.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

interface CanonFragment {
    text: string;
    source: string;
}

let _fragments: CanonFragment[] = [];
let _loaded = false;

/**
 * Parse Canon.md and extract all blockquoted fragments.
 * Format expected: > "quote text" — Source, Work
 */
function loadCanon(): void {
    if (_loaded) return;

    try {
        const canonPath = path.resolve(__dirname, "../../Canon.md");
        if (!fs.existsSync(canonPath)) {
            logger.warn("canon_file_not_found", { path: canonPath });
            _loaded = true;
            return;
        }

        const content = fs.readFileSync(canonPath, "utf-8");
        const lines = content.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith(">")) continue;

            // Remove the leading `> ` and parse
            const raw = trimmed.replace(/^>\s*/, "").trim();
            if (!raw || raw.startsWith("#")) continue;

            // Split on ` — ` to separate quote from attribution
            const dashIndex = raw.lastIndexOf(" — ");
            if (dashIndex > 0) {
                const text = raw.substring(0, dashIndex).replace(/^"|"$/g, "").trim();
                const source = raw.substring(dashIndex + 3).trim();
                if (text.length > 10) {
                    _fragments.push({ text, source });
                }
            } else {
                // No attribution found — use the whole line as text
                const text = raw.replace(/^"|"$/g, "").trim();
                if (text.length > 10) {
                    _fragments.push({ text, source: "Unknown" });
                }
            }
        }

        _loaded = true;
        logger.info("canon_loaded", { fragments: _fragments.length });
    } catch (err: any) {
        logger.error("canon_load_error", {}, err);
        _loaded = true; // Don't retry on failure
    }
}

/**
 * Get a random Canon fragment. Returns a fallback if Canon is empty.
 */
export function getRandomCanonFragment(): string {
    loadCanon();

    if (_fragments.length === 0) {
        return "Commerce is the great civilizer. We exchange when we cannot take.";
    }

    const fragment = _fragments[Math.floor(Math.random() * _fragments.length)];
    return `${fragment.text} — ${fragment.source}`;
}

/**
 * Get a Canon fragment matching a theme keyword.
 * Falls back to random if no match found.
 */
export function getCanonFragmentByTheme(theme: string): string {
    loadCanon();

    if (_fragments.length === 0) {
        return "Commerce is the great civilizer. We exchange when we cannot take.";
    }

    const lower = theme.toLowerCase();
    const matching = _fragments.filter(
        (f) =>
            f.text.toLowerCase().includes(lower) ||
            f.source.toLowerCase().includes(lower)
    );

    if (matching.length > 0) {
        const fragment = matching[Math.floor(Math.random() * matching.length)];
        return `${fragment.text} — ${fragment.source}`;
    }

    return getRandomCanonFragment();
}

/**
 * Get all loaded fragments (for debugging / introspection).
 */
export function getAllCanonFragments(): CanonFragment[] {
    loadCanon();
    return [..._fragments];
}
