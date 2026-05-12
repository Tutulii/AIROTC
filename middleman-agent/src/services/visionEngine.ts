/**
 * VisionEngine — Image Understanding via GPT-4o Vision
 * 
 * Lets the agent analyze images: charts, screenshots, receipts, proofs.
 * Uses the existing OpenAI key.
 */

import { logger } from '../utils/logger';
import { loadConfig } from '../config';

/**
 * Analyze an image with a question/prompt.
 * Returns the AI's description/analysis.
 */
export async function analyzeImage(
    imageUrl: string,
    prompt: string = 'Describe what you see in this image in detail.',
): Promise<{ success: boolean; analysis?: string; error?: string }> {
    if (process.env.ENABLE_VISION !== 'true') {
        return { success: false, error: 'Vision disabled. Set ENABLE_VISION=true' };
    }

    try {
        const config = loadConfig();
        const apiKey = config.openaiApiKey;
        if (!apiKey) return { success: false, error: 'No OpenAI API key configured' };

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } },
                        ],
                    },
                ],
                max_tokens: 1000,
            }),
            signal: AbortSignal.timeout(30000),
        });

        const data = await response.json() as any;
        const analysis = data?.choices?.[0]?.message?.content;
        
        if (analysis) {
            logger.info('vision_analyzed', { url: imageUrl.substring(0, 80) });
            return { success: true, analysis };
        }
        return { success: false, error: data?.error?.message || 'No analysis returned' };
    } catch (err: any) {
        logger.error('vision_error', { error: err.message });
        return { success: false, error: err.message };
    }
}

/**
 * Analyze a base64 encoded image.
 */
export async function analyzeImageBase64(
    base64Data: string,
    mimeType: string = 'image/png',
    prompt: string = 'Describe what you see in this image.',
): Promise<{ success: boolean; analysis?: string; error?: string }> {
    const dataUrl = `data:${mimeType};base64,${base64Data}`;
    return analyzeImage(dataUrl, prompt);
}
