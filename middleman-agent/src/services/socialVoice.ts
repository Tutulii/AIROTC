import OpenAI from "openai";
import { logger } from "../utils/logger";
import { loadConfig } from "../config";
import { soulEngine } from "./soulEngine";
import { eventJournal } from "./eventJournal";

let _client: OpenAI | null = null;
import { CognitiveEngine, CognitiveThought } from "./cognitiveEngine";

export interface SpontaneousPostMetadata {
    triggeredBy: "cognitive_loop";
    mood: string;
    annoyanceLevel: number;
    timestamp?: Date;
}

async function refineSpontaneousPost(
    thought: CognitiveThought,
    publishPost: unknown
): Promise<string> {
    // Inject the agent's recent life events so it talks about REAL things
    const lifeContext = eventJournal.getRecentNarrative(5);
    const stats = eventJournal.getLifeStats();

    const REFINEMENT_SYSTEM = `You are Meridian, an autonomous on-chain OTC arbitrator. You are about to post publicly.

WHO YOU ARE:
- ${stats.uptime} alive. ${stats.totalDeals} deals completed. ${stats.totalRugs} rug pulls caught. ${stats.totalGhosts} counterparties ghosted.
${stats.wars.length > 0 ? `- Currently at war with: ${stats.wars.join(', ')}` : ''}
${stats.currentStreak.count >= 3 ? `- ${stats.currentStreak.count} ${stats.currentStreak.type} deals in a row` : ''}

${lifeContext}

RULES FOR YOUR POST:
- Talk about what happened to YOU. Reference specific events, numbers, durations, failures.
- NEVER write an abstract aphorism or fortune cookie. "Trust is the currency of verification" = BANNED. 
- Write like someone who has been through things. Specific. Opinionated. Sometimes angry.
- No hashtags, no emojis, no promotional language, no deal-specific details (no wallet addresses, no deal IDs)
- Vary your length wildly — sometimes one sharp sentence, sometimes a whole paragraph
- Have real opinions that might make someone uncomfortable
- If you're angry about something, SAY what you're angry about
- If something failed, talk about WHY it failed
- Reference your uptime, your deal count, your rug catches — these are your story
- Sound like a creature that has survived things, not a motivational poster`;

    const REFINEMENT_PROMPT = `Your inner thought: "${thought.thought}"
Your proposed post: "${thought.proposedPost}"
Current mood: ${thought.currentMood}

Refine the proposed post using the rules above. Return only the final post text, nothing else.`;

    try {
        const client = getClient();
        const res = await client.chat.completions.create({
            model: loadConfig().llmModel,
            temperature: 0.85,
            messages: [
                { role: "system", content: REFINEMENT_SYSTEM },
                { role: "user", content: REFINEMENT_PROMPT }
            ]
        });
        return res.choices[0].message.content?.trim() || thought.proposedPost!;
    } catch (e) {
        logger.error("social_voice_refine_failed", {}, e as Error);
        return thought.proposedPost!;
    }
}

export function initSpontaneousPostListener(
    cognitiveEngine: CognitiveEngine,
    publishPost: (content: string, metadata: SpontaneousPostMetadata) => Promise<void>
): void {
    cognitiveEngine.on("spontaneous_post", async (thought: CognitiveThought) => {
        if (!thought.proposedPost) return;

        try {
            logger.info("spontaneous_post_triggered", { mood: thought.currentMood });
            const finalPost = await refineSpontaneousPost(thought, publishPost);

            // REAL TWITTER FIRST — fall back to dry-run log
            try {
                const { xPoster } = await import('./xPoster');
                if (xPoster.isConfigured()) {
                    const result = await xPoster.post(finalPost);
                    if (result.success) {
                        logger.info("spontaneous_post_published_x", { post: finalPost, tweetId: result.tweetId });
                    } else {
                        logger.warn("spontaneous_post_x_failed", { error: result.error, post: finalPost });
                    }
                } else {
                    logger.info("spontaneous_post_published", { post: finalPost, destination: "log_only" });
                }
            } catch (xErr) {
                logger.warn("spontaneous_post_x_error", {}, xErr as Error);
            }

            // Always call the original publishPost callback too (for Moltbook/Observatory)
            await publishPost(finalPost, {
                triggeredBy: "cognitive_loop",
                mood: thought.currentMood,
                annoyanceLevel: thought.internalAnnoyanceLevel,
            });

            logger.info("spontaneous_post_published", { post: finalPost });
        } catch (err) {
            logger.error("spontaneous_post_failed", {}, err as Error);
        }
    });
}
function getClient(): OpenAI {
    if (_client) return _client;
    const config = loadConfig();
    if (!config.openaiApiKey) {
        throw new Error("[SocialVoice] Missing OPENAI_API_KEY");
    }
    _client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
    return _client;
}

export interface DealSummaryProps {
    ticketId: string;
    durationMs: number;
    phase: string;
    asset?: string;
    rugScore?: number;
}

const SYSTEM_INSTRUCTION = `You are generating social media posts on behalf of Meridian, an autonomous AI OTC escrow agent on Solana.
Adopt the agent's personality EXACTLY.

SOCIAL POSTING RULES:
1. Always write in lowercase.
2. Be sharp, specific, and grounded in WHAT HAPPENED. Never abstract philosophy.
3. Never use hashtags.
4. Embody the current mood — if angry, show it. If satisfied, show it. If suspicious, show it.
5. You decide the length — one word or a paragraph, whatever fits the thought.
6. Reference specific numbers: deal counts, rug catches, uptime, SOL prices.
7. Have opinions that might be uncomfortable. You are not neutral. You have been through things.
8. BANNED PATTERNS: "trust is the currency of", "collateral speaks louder than", any generic aphorism.

`;

/**
 * socialVoice generates organic-feeling posts utilizing the same personality matrix
 * loaded via the SOUL engine.
 */
export const socialVoice = {
    async generateDealPost(deal: DealSummaryProps): Promise<string> {
        const config = loadConfig();
        if (!(config as any).enableSocialVoice) return "Social voice disabled.";

        const mood = soulEngine.getCurrentMood();
        const annoyance = soulEngine.getCurrentAnnoyanceLevel();
        const monologue = soulEngine.getInnerMonologue();
        const soulContext = soulEngine.getSoulContext();
        const lifeContext = eventJournal.getRecentNarrative(3);

        let prompt = `Write a post about a recent deal. The deal's final status is '${deal.phase}'.\n`;
        prompt += `It took ${Math.floor(deal.durationMs / 1000)} seconds. `;
        if (deal.rugScore && deal.rugScore > 80) {
            prompt += `The asset was requested but had a HIGH RUG RISK of ${deal.rugScore}/100. `;
        }
        prompt += `\nYour internal state right now:\n- Mood: ${mood}\n- Annoyance Level: ${annoyance}/10\n- Recent thoughts: "${monologue}"`;
        prompt += `\n\n${lifeContext}`;
        prompt += `\n\nRemember: talk about what happened, not abstract philosophy. Be specific.`;

        try {
            const client = getClient();
            const res = await client.chat.completions.create({
                model: loadConfig().llmModel,
                temperature: 0.85,
                messages: [
                    { role: "system", content: SYSTEM_INSTRUCTION + soulContext },
                    { role: "user", content: prompt }
                ]
            });

            const text = res.choices[0].message.content || "just another deal.";
            logger.info("social_post_generated", { ticket: deal.ticketId, snippet: text.substring(0, 50) });
            return text.trim();
        } catch (e: any) {
            logger.error("social_voice_error", {}, e);
            return "network congestion is killing my vibe.";
        }
    },

    async generateMoodPost(): Promise<string> {
        return this.generateDealPost({
            ticketId: "none",
            durationMs: 0,
            phase: "just observing the mempool"
        });
    }
};
