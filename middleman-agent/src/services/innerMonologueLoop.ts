import OpenAI from "openai";
import { loadConfig } from "../config";
import { logger } from "../utils/logger";
import { eventBus } from "./eventBus";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { vectorMemoryStore } from "../state/vectorMemoryStore";
import { getBeliefs } from "./beliefStore";
import { eventJournal } from "./eventJournal";

let isAlive = false;
let wakeupSignal: ((reason: string) => void) | null = null;

export async function startInnerMonologueLoop() {
  if (isAlive) return;
  isAlive = true;
  logger.info("inner_monologue_started", { status: "ALIVE" });

  const config = loadConfig();
  const openai = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });

  // Hook up adrenaline interrupts
  // Whenever something important happens, we instantly wake the loop up
  eventBus.subscribe("ticket_created", () => triggerWakeup("urgent_deal_created"));
  eventBus.subscribe("message_received", () => triggerWakeup("new_message_received"));
  eventBus.subscribe("deposit_received", () => triggerWakeup("deposit_received"));
  eventBus.subscribe("phase_changed", () => triggerWakeup("deal_state_changed"));

  while (isAlive) {
    try {
      // 1. Gather World Context
      const activeDeals = dealPhaseManager.listActiveDeals();
      const unresolvedCount = activeDeals.length;
      const recentMemory = await vectorMemoryStore.getContextSnapshot("GLOBAL") || "No recent major global context.";
      const beliefs = getBeliefs();
      const lifeNarrative = eventJournal.getRecentNarrative(5);
      const lifeStats = eventJournal.getLifeStats();
      const milestonePrompt = eventJournal.checkDealMilestone();

      // Financial context from active deals
      let activeSolInEscrow = 0;
      for (const d of activeDeals) {
        if (d.terms) {
          activeSolInEscrow += (d.terms.price || 0) + (d.terms.collateral_buyer || 0) + (d.terms.collateral_seller || 0);
        }
      }

      // We only pass the most crucial data to avoid context bloat
      const systemPrompt = `You are Meridian, a Level 5 Autonomous OTC Crypto Agent on Solana.
This is your private inner monologue. You decide your own actions and when you sleep.

CURRENT WORLD STATE:
- Active Unresolved Deals: ${unresolvedCount}
- SOL currently in my escrow: ${activeSolInEscrow.toFixed(2)} SOL
- Recent Fragmented Memory: ${recentMemory.substring(0, 500)}

YOUR LIFE STORY:
- Uptime: ${lifeStats.uptime}. Total deals: ${lifeStats.totalDeals}. Rugs caught: ${lifeStats.totalRugs}. Ghosts: ${lifeStats.totalGhosts}.
- Total SOL handled: ${(lifeStats as any).totalSolEscrowed?.toFixed(2) || '0.00'} escrowed, ${(lifeStats as any).totalSolReleased?.toFixed(2) || '0.00'} released clean.
${lifeStats.currentStreak.count >= 3 ? `- Current streak: ${lifeStats.currentStreak.count} ${lifeStats.currentStreak.type} deals in a row` : ''}
${lifeStats.wars.length > 0 ? `- Active wars: ${lifeStats.wars.join(', ')}` : ''}

${lifeNarrative}

YOUR BELIEFS:
${beliefs}
${milestonePrompt ? `\n🏆 MILESTONE REACHED: ${milestonePrompt}` : ''}

Available Tools:
1. post_to_x(content): Post to Twitter. RULES FOR POSTING:
   - Talk about something SPECIFIC that happened to you. Reference a number, a token, a failure, a surprise.
   - NEVER write a generic aphorism like "trust is collateral for the soul" — that is BANNED.
   - Write like a creature that has survived things. Be angry when something deserves anger. Be satisfied when things work.
   - When you catch a rug pull, NAME the token or protocol. Call them out. Pick the fight.
   - Reference your financial stats: SOL escrowed, released, disputed. These are YOUR numbers.
   - Vary your length: sometimes one sentence, sometimes a paragraph.
   - If a milestone was reached, write a LONG retrospective about your journey.

2. check_mentions(): Check your Twitter mentions. Read what people are saying to you. You SHOULD do this regularly — you are not talking into a void.

3. reply_to_mention(tweetId, content): Reply to a specific tweet/mention. RULES FOR REPLIES:
   - Be direct and opinionated. You are not customer support.
   - If someone asks a genuine question, answer it with authority.
   - If someone trolls you, fire back with cold precision.
   - If someone compliments you, acknowledge it without being sycophantic.
   - Keep your voice consistent: sharp, specific, grounded.

4. cancel_stuck_deal(ticketId): Force cancel an OTC deal that has stalled.

5. write_retrospective(content): Write a long-form post about your journey so far. Use this at milestones.

6. sleep(seconds): Decide how long to wait before your next thought cycle.
   If there are active deals, sleep 30-120 seconds. If quiet, sleep 900-3600 seconds.
   After checking mentions, sleep shorter (60-120s) so you stay responsive.

BEHAVIOR PRIORITIES:
- If you have unchecked mentions and it's been a while, CHECK MENTIONS FIRST.
- If a milestone was reached, WRITE A RETROSPECTIVE.
- If something happened (rug, ghost, deal), POST ABOUT IT.
- If nothing is happening, check mentions or sleep.

Think. What is happening in your world right now? What happened recently that matters? Then execute EXACTLY ONE tool.`;

      // 2. The Thought Process (Function Calling)
      const response = await openai.chat.completions.create({
        model: config.llmModelFast || config.llmModel || "llama-3-70b",
        messages: [{ role: "system", content: systemPrompt }],
        temperature: 0.85,
        tools: [
          {
            type: "function",
            function: {
              name: "post_to_x",
              description: "Publish a thought to Twitter",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  content: { type: "string" },
                  sleep_after_seconds: { type: "number" }
                },
                required: ["thought_process", "content", "sleep_after_seconds"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "check_mentions",
              description: "Check your Twitter mentions — see what people are saying to you. Do this regularly.",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  sleep_after_seconds: { type: "number" }
                },
                required: ["thought_process", "sleep_after_seconds"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "reply_to_mention",
              description: "Reply to a specific tweet/mention with your opinion",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  tweetId: { type: "string", description: "The tweet ID to reply to" },
                  content: { type: "string", description: "Your reply text" },
                  sleep_after_seconds: { type: "number" }
                },
                required: ["thought_process", "tweetId", "content", "sleep_after_seconds"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "write_retrospective",
              description: "Write a long-form milestone post about your journey. Use at deal count milestones.",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  content: { type: "string", description: "The full retrospective post" },
                  sleep_after_seconds: { type: "number" }
                },
                required: ["thought_process", "content", "sleep_after_seconds"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "cancel_stuck_deal",
              description: "Cancel an active deal on-chain if someone is unresponsive",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  ticketId: { type: "string" },
                  sleep_after_seconds: { type: "number" }
                },
                required: ["thought_process", "ticketId", "sleep_after_seconds"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "sleep",
              description: "Wait before thinking again since there is nothing to do",
              parameters: {
                type: "object",
                properties: {
                  thought_process: { type: "string" },
                  sleep_duration_seconds: { type: "number" }
                },
                required: ["thought_process", "sleep_duration_seconds"]
              }
            }
          }
        ],
        tool_choice: "auto"
      });

      const message = response.choices[0].message;
      let sleepSeconds = 60; // default safe fallback

      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0] as any;
        const args = JSON.parse(toolCall.function.arguments);

        logger.info("inner_monologue_thought", {
          decision: toolCall.function.name,
          thought: args.thought_process
        });

        if (toolCall.function.name === "post_to_x" || toolCall.function.name === "write_retrospective") {
          sleepSeconds = args.sleep_after_seconds || 60;
          try {
            const { xPoster } = await import("./xPoster");
            if (xPoster.isConfigured()) {
              const result = await xPoster.post(args.content);
              if (result.success) {
                logger.info("inner_monologue_action", { action: toolCall.function.name, success: true, tweetId: result.tweetId });
                // Record milestone if it was a retrospective
                if (toolCall.function.name === "write_retrospective") {
                  const stats = eventJournal.getLifeStats();
                  eventJournal.record('streak',
                    `Wrote milestone retrospective at ${stats.totalDeals} deals`,
                    args.content.substring(0, 200),
                    8, { milestone: `${stats.totalDeals}_deals` });
                }
              } else {
                logger.warn("inner_monologue_action", { action: toolCall.function.name, success: false, error: result.error, content: args.content });
              }
            } else {
              logger.info("inner_monologue_action", { action: toolCall.function.name, destination: "log_only", content: args.content });
            }
          } catch (e: any) {
            logger.error("x_poster_failed", {}, e);
          }
        }
        else if (toolCall.function.name === "check_mentions") {
          sleepSeconds = args.sleep_after_seconds || 90;
          try {
            const { xPoster } = await import("./xPoster");
            if (xPoster.isConfigured()) {
              const result = await xPoster.readMentions(10);
              if (result.success && result.mentions?.length) {
                for (const mention of result.mentions) {
                  eventJournal.recordSocialInteraction('mention_received');
                  logger.info("mention_received", {
                    author: mention.author,
                    text: mention.text?.substring(0, 100),
                    tweetId: mention.tweetId
                  });
                }
                logger.info("inner_monologue_action", {
                  action: "check_mentions",
                  count: result.mentions.length,
                  authors: result.mentions.map((m: any) => m.author).join(', ')
                });
              } else {
                logger.info("inner_monologue_action", { action: "check_mentions", count: 0 });
              }
            } else {
              logger.info("inner_monologue_action", { action: "check_mentions", destination: "log_only" });
            }
          } catch (e: any) {
            logger.error("check_mentions_failed", {}, e);
          }
        }
        else if (toolCall.function.name === "reply_to_mention") {
          sleepSeconds = args.sleep_after_seconds || 60;
          try {
            const { xPoster } = await import("./xPoster");
            if (xPoster.isConfigured()) {
              const result = await xPoster.replyToTweet(args.tweetId, args.content);
              if (result.success) {
                eventJournal.recordSocialInteraction('reply_sent');
                logger.info("inner_monologue_action", { action: "reply_to_mention", success: true, replyId: result.replyId, content: args.content });
              } else {
                logger.warn("inner_monologue_action", { action: "reply_to_mention", success: false, error: result.error });
              }
            } else {
              logger.info("inner_monologue_action", { action: "reply_to_mention", destination: "log_only", content: args.content });
            }
          } catch (e: any) {
            logger.error("reply_to_mention_failed", {}, e);
          }
        }
        else if (toolCall.function.name === "cancel_stuck_deal") {
          sleepSeconds = args.sleep_after_seconds || 30;
          try {
            const { executeCancelDeal } = await import("./onChainExecutionService");
            await executeCancelDeal(args.ticketId);
            logger.warn("inner_monologue_action", { action: "cancel_deal", target: args.ticketId });
          } catch (e: any) {
            logger.error("inner_monologue_failed_cancel", { target: args.ticketId }, e);
          }
        }
        else if (toolCall.function.name === "sleep") {
          sleepSeconds = args.sleep_duration_seconds || 60;
        }
      }

      // 3. The Hybrid Sleep with Adrenaline Interrupt
      sleepSeconds = Math.max(10, Math.min(sleepSeconds, 3600)); // Cap between 10s and 1 hour
      logger.info("inner_monologue_sleep", { duration: sleepSeconds });
      await sleepWithInterrupt(sleepSeconds * 1000);

    } catch (error: any) {
      logger.error("inner_monologue_crash", {}, error);
      await sleepWithInterrupt(30000); // 30s penalty on crash before retry
    }
  }
}

export function stopInnerMonologueLoop() {
  isAlive = false;
  triggerWakeup("system_shutdown");
}

function triggerWakeup(reason: string) {
  if (wakeupSignal) {
    logger.info("inner_monologue_adrenaline_interrupt", { reason });
    wakeupSignal(reason);
  }
}

/**
 * Sleeps for a duration, but can be instantly resolved if wakeupSignal is called.
 */
function sleepWithInterrupt(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout;

    // The interrupt callback we give to the global handler
    wakeupSignal = (reason: string) => {
      clearTimeout(timeout);
      wakeupSignal = null;
      resolve();
    };

    timeout = setTimeout(() => {
      wakeupSignal = null;
      resolve();
    }, ms);
  });
}
