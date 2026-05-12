/**
 * Embedding Service
 *
 * Generates semantic vector embeddings for negotiation messages.
 * Uses OpenAI text-embedding-ada-002 (1536 dimensions) if OPENAI_API_KEY is set.
 * Falls back to a deterministic local embedding for devnet testing.
 */

import { logger } from "../utils/logger";

const EMBEDDING_DIM = 1536;

export async function generateEmbedding(text: string): Promise<number[] | null> {
    if (!text || text.trim() === "") return null;

    if (process.env.OPENAI_API_KEY) {
        try {
            const response = await fetch("https://api.openai.com/v1/embeddings", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: "text-embedding-ada-002",
                    input: text.trim(),
                }),
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`OpenAI API error: ${err}`);
            }

            const data = await response.json() as { data: { embedding: number[] }[] };
            const embedding = data.data[0].embedding;

            logger.info("embedding_generated", {
                model: "text-embedding-ada-002",
                dims: embedding.length,
                preview: text.slice(0, 60),
            });

            return embedding;
        } catch (e) {
            logger.error("embedding_openai_failed", {}, e);
        }
    }

    try {
        const embedding = localFallbackEmbedding(text);
        logger.info("embedding_generated_local_fallback", {
            dims: embedding.length,
            preview: text.slice(0, 60),
        });
        return embedding;
    } catch (e) {
        logger.error("embedding_fallback_failed", {}, e);
        return null;
    }
}

function localFallbackEmbedding(text: string): number[] {
    const embedding = new Array(EMBEDDING_DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        for (let j = 0; j < 4; j++) {
            const dim = (charCode * (i + 1) * (j + 7)) % EMBEDDING_DIM;
            embedding[dim] = (embedding[dim] + charCode / 128.0) % 1.0;
        }
    }
    const magnitude = Math.sqrt(embedding.reduce((sum: number, v: number) => sum + v * v, 0));
    return magnitude > 0 ? embedding.map((v: number) => v / magnitude) : embedding;
}
