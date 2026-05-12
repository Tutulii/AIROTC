/**
 * Memory Retrieval Service
 *
 * High-level interface for agent reasoning context.
 * Fetches semantically relevant past negotiation messages
 * and formats them into an LLM-ready context string.
 */

import { vectorMemoryStore, VectorMemoryEntry } from "../state/vectorMemoryStore";
import { logger } from "../utils/logger";

export interface RelevantContext {
    entries: VectorMemoryEntry[];
    contextString: string;
}

export async function getRelevantContext(
    ticketId: string,
    query: string,
    limit: number = 5
): Promise<RelevantContext> {
    const entries = await vectorMemoryStore.searchSimilar({ ticketId, query, limit });

    if (entries.length === 0) {
        logger.debug("memory_retrieval_empty", { ticket_id: ticketId, query: query.slice(0, 60) });
        return { entries: [], contextString: "" };
    }

    const contextString = entries
        .map((e, i) => `[Context ${i + 1}] (similarity: ${(1 - (e.distance ?? 1)).toFixed(3)}): ${e.content}`)
        .join("\n");

    logger.info("memory_retrieval_success", {
        ticket_id: ticketId,
        query: query.slice(0, 60),
        retrieved: entries.length,
    });

    return { entries, contextString };
}
