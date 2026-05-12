/**
 * ImageGenerator — AI Image Generation via DALL-E 3
 * 
 * Generate trade cards, receipt images, data visualizations.
 * Uses the existing OpenAI key.
 */

import { logger } from '../utils/logger';
import { loadConfig } from '../config';

/**
 * Generate an image from a text prompt.
 * Returns the URL of the generated image.
 */
export async function generateImage(
    prompt: string,
    opts: {
        size?: '1024x1024' | '1792x1024' | '1024x1792';
        quality?: 'standard' | 'hd';
        style?: 'vivid' | 'natural';
    } = {},
): Promise<{ success: boolean; url?: string; revisedPrompt?: string; error?: string }> {
    if (process.env.ENABLE_IMAGE_GEN !== 'true') {
        return { success: false, error: 'Image generation disabled. Set ENABLE_IMAGE_GEN=true' };
    }

    try {
        const config = loadConfig();
        const apiKey = config.openaiApiKey;
        if (!apiKey) return { success: false, error: 'No OpenAI API key configured' };

        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'dall-e-3',
                prompt,
                n: 1,
                size: opts.size || '1024x1024',
                quality: opts.quality || 'standard',
                style: opts.style || 'vivid',
            }),
            signal: AbortSignal.timeout(60000),
        });

        const data = await response.json() as any;
        const result = data?.data?.[0];

        if (result?.url) {
            logger.info('image_generated', { prompt: prompt.substring(0, 80) });
            return {
                success: true,
                url: result.url,
                revisedPrompt: result.revised_prompt,
            };
        }
        return { success: false, error: data?.error?.message || 'No image returned' };
    } catch (err: any) {
        logger.error('image_gen_error', { error: err.message });
        return { success: false, error: err.message };
    }
}
