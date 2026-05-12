/**
 * OutputValidator — Structured Output Validation via Zod
 * 
 * Replaces JSON.parse guessing with schema-enforced parsing.
 * If LLM output doesn't match schema, retries with corrective prompt.
 * 
 * Inspired by CrewAI's Pydantic enforcement.
 */

import { z } from 'zod';
import { logger } from '../utils/logger';

// ─── Pre-defined Schemas ────────────────────────────────────

/** Tool call from the curiosity engine ReAct loop */
export const ToolCallSchema = z.object({
    tool: z.string().min(1),
    args: z.union([z.record(z.any()), z.string()]),
    thought: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Trade analysis from middlemanBrain */
export const TradeAnalysisSchema = z.object({
    action: z.enum(['accept', 'reject', 'counter', 'hold', 'escalate']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    counterPrice: z.number().optional(),
    counterTerms: z.string().optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});
export type TradeAnalysis = z.infer<typeof TradeAnalysisSchema>;

/** Negotiation message analysis */
export const MessageAnalysisSchema = z.object({
    intent: z.enum(['offer', 'counter', 'accept', 'reject', 'question', 'info', 'greeting', 'complaint']),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'hostile']),
    extractedPrice: z.number().optional(),
    extractedAsset: z.string().optional(),
    requiresResponse: z.boolean(),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
});
export type MessageAnalysis = z.infer<typeof MessageAnalysisSchema>;

/** Curiosity cycle end decision */
export const CycleDecisionSchema = z.object({
    thought: z.string(),
    nextDelayMinutes: z.number().min(1).max(120),
    topicsExplored: z.array(z.string()).optional(),
    insightsGained: z.array(z.string()).optional(),
});
export type CycleDecision = z.infer<typeof CycleDecisionSchema>;

/** Goal progress update */
export const GoalUpdateSchema = z.object({
    goalId: z.string(),
    progress: z.number().min(0).max(100),
    note: z.string().optional(),
});
export type GoalUpdate = z.infer<typeof GoalUpdateSchema>;

// ─── Validation Engine ──────────────────────────────────────

/**
 * Parse and validate LLM output against a Zod schema.
 * Returns parsed data or null if validation fails.
 */
export function validateOutput<T>(
    rawOutput: string,
    schema: z.ZodSchema<T>,
): { success: true; data: T } | { success: false; errors: string[] } {
    try {
        // Try direct JSON parse
        let parsed: any;
        
        // Extract JSON from markdown code blocks if present
        const jsonMatch = rawOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        const rawJson = jsonMatch ? jsonMatch[1].trim() : rawOutput.trim();

        try {
            parsed = JSON.parse(rawJson);
        } catch {
            // Try to find JSON object in the text
            const objMatch = rawJson.match(/\{[\s\S]*\}/);
            if (objMatch) {
                parsed = JSON.parse(objMatch[0]);
            } else {
                return { success: false, errors: ['No valid JSON found in output'] };
            }
        }

        const result = schema.safeParse(parsed);
        if (result.success) {
            return { success: true, data: result.data };
        } else {
            const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
            logger.debug('output_validation_failed', { errors });
            return { success: false, errors };
        }
    } catch (err: any) {
        return { success: false, errors: [err.message] };
    }
}

/**
 * Validate with retry — if first attempt fails, call retryFn with error feedback.
 */
export async function validateWithRetry<T>(
    rawOutput: string,
    schema: z.ZodSchema<T>,
    retryFn: (errorFeedback: string) => Promise<string>,
    maxRetries: number = 2,
): Promise<T | null> {
    let attempt = validateOutput(rawOutput, schema);
    if (attempt.success) return attempt.data;

    for (let i = 0; i < maxRetries; i++) {
        const feedback = `Your previous output failed validation:\n${attempt.errors.join('\n')}\n\nPlease fix and respond with valid JSON matching the schema.`;
        const retryOutput = await retryFn(feedback);
        attempt = validateOutput(retryOutput, schema);
        if (attempt.success) return attempt.data;
        logger.debug('output_retry_failed', { attempt: i + 1, errors: attempt.errors });
    }

    logger.warn('output_validation_exhausted', { errors: attempt.errors });
    return null;
}

/**
 * Generate a human-readable schema description for LLM prompts.
 */
export function schemaToPrompt(schema: z.ZodSchema): string {
    try {
        // Use Zod's internal shape for object schemas
        if (schema instanceof z.ZodObject) {
            const shape = schema.shape;
            const fields = Object.entries(shape).map(([key, value]: [string, any]) => {
                const isOptional = value instanceof z.ZodOptional;
                const desc = value.description || value._def?.typeName || 'any';
                return `  "${key}": ${desc}${isOptional ? ' (optional)' : ' (required)'}`;
            });
            return `{\n${fields.join(',\n')}\n}`;
        }
        return 'JSON object';
    } catch {
        return 'JSON object';
    }
}
