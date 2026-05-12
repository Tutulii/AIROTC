/**
 * Vector Memory Store
 *
 * Persists semantic embeddings of negotiation messages to PostgreSQL (pgvector).
 * Uses raw SQL because Prisma does not natively support vector column types.
 *
 * Also maintains an in-memory context cache per ticket so that synchronous
 * callers (commandParser, dealPhaseManager) can retrieve recent context
 * without awaiting a DB round-trip.
 */

import { prisma } from "../lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { generateEmbedding } from "../services/embeddingService";
import { logger } from "../utils/logger";

export interface VectorMemoryEntry {
  id: string;
  ticketId: string;
  messageId?: string;
  content: string;
  distance?: number;
  createdAt: string;
}

// In-memory context cache: ticketId → list of recent message strings
const contextCache: Map<string, string[]> = new Map();
const MAX_CONTEXT_MESSAGES = 20;

class VectorMemoryStore {
  /**
   * Embed and store a message in the VectorMemory table.
   * Also caches the message content for synchronous context retrieval.
   * Non-blocking: if embedding fails, logs and returns without throwing.
   */
  public async storeMemory(params: {
    ticketId: string;
    messageId?: string;
    content: string;
  }): Promise<void> {
    const { ticketId, messageId, content } = params;

    // Always update in-memory cache (even if embedding fails)
    if (!contextCache.has(ticketId)) {
      contextCache.set(ticketId, []);
    }
    const cache = contextCache.get(ticketId)!;
    cache.push(content);
    if (cache.length > MAX_CONTEXT_MESSAGES) {
      cache.shift(); // Remove oldest
    }

    try {
      const embedding = await generateEmbedding(content);
      if (!embedding) {
        logger.warn("vector_store_skipped", { ticket_id: ticketId, reason: "null_embedding" });
        return;
      }

      const id = uuidv4();
      const vectorLiteral = `[${embedding.join(",")}]`;

      await prisma.$executeRaw`
        INSERT INTO "VectorMemory" (id, "ticketId", "messageId", content, embedding, "createdAt")
        VALUES (
          ${id},
          ${ticketId},
          ${messageId ?? null},
          ${content},
          ${vectorLiteral}::vector,
          NOW()
        )
      `;

      logger.info("vector_memory_stored", { ticket_id: ticketId, id, preview: content.slice(0, 60) });
    } catch (e) {
      // CRITICAL: never block the pipeline on embedding failures
      logger.error("vector_store_failed", { ticket_id: ticketId }, e);
    }
  }

  /**
   * Synchronous context snapshot for LLM prompts.
   * Returns the last N messages for a ticket as a single string.
   * Used by commandParser and dealPhaseManager (AI Judge).
   */
  public getContextSnapshot(ticketId: string): string {
    const cache = contextCache.get(ticketId);
    if (!cache || cache.length === 0) {
      return "[No conversation context available]";
    }
    return cache.join("\n");
  }

  /**
   * Similarity search: find the N most semantically similar memories for a ticket.
   * Returns ordered results (most similar first).
   */
  public async searchSimilar(params: {
    ticketId: string;
    query: string;
    limit?: number;
  }): Promise<VectorMemoryEntry[]> {
    const { ticketId, query, limit = 5 } = params;

    try {
      const embedding = await generateEmbedding(query);
      if (!embedding) {
        logger.warn("vector_search_skipped", { ticket_id: ticketId, reason: "could_not_embed_query" });
        return [];
      }

      const vectorLiteral = `[${embedding.join(",")}]`;

      const results = await prisma.$queryRaw<
        Array<{ id: string; ticketId: string; messageId: string | null; content: string; distance: number; createdAt: Date }>
      >`
        SELECT id, "ticketId", "messageId", content, "createdAt",
               embedding <-> ${vectorLiteral}::vector AS distance
        FROM "VectorMemory"
        WHERE "ticketId" = ${ticketId}
        ORDER BY embedding <-> ${vectorLiteral}::vector
        LIMIT ${limit}
      `;

      logger.info("vector_search_completed", {
        ticket_id: ticketId,
        query: query.slice(0, 60),
        results_found: results.length,
      });

      return results.map((r) => ({
        id: r.id,
        ticketId: r.ticketId,
        messageId: r.messageId ?? undefined,
        content: r.content,
        distance: r.distance,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (e) {
      logger.error("vector_search_failed", { ticket_id: ticketId }, e);
      return [];
    }
  }

  /**
   * Get all vector memories for a ticket (ordered by time).
   */
  public async getMemoriesForTicket(ticketId: string): Promise<VectorMemoryEntry[]> {
    const results = await prisma.$queryRaw<
      Array<{ id: string; ticketId: string; messageId: string | null; content: string; createdAt: Date }>
    >`
      SELECT id, "ticketId", "messageId", content, "createdAt"
      FROM "VectorMemory"
      WHERE "ticketId" = ${ticketId}
      ORDER BY "createdAt" ASC
    `;

    return results.map((r) => ({
      id: r.id,
      ticketId: r.ticketId,
      messageId: r.messageId ?? undefined,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export const vectorMemoryStore = new VectorMemoryStore();
