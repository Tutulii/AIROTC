/**
 * Evaluator: dealProgressEvaluator
 * 
 * Runs after every agent response to detect deal phase transitions,
 * extract negotiated terms, and track deal lifecycle milestones.
 * 
 * Follows real @elizaos/core Evaluator interface.
 */
import type { Evaluator, IAgentRuntime, Memory, State, Content } from "../../elizaos-core";
import { logger } from "../../elizaos-core";

export const dealProgressEvaluator: Evaluator = {
  name: "deal-progress-evaluator",
  description: "Extracts deal milestones and phase transitions from messages.",
  alwaysRun: true,

  examples: [
    {
      prompt: "Extract deal phase from conversation",
      messages: [
        { name: "middleman", content: { text: "Escrow created. Please deposit your collateral." } as Content },
        { name: "AlphaTrader", content: { text: "I have deposited my collateral." } as Content },
      ],
      outcome: "Phase transition: negotiation → awaiting_deposits",
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Run on all messages that have text content
    return !!message.content?.text;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<unknown> => {
    const text = message.content.text.toLowerCase();
    const rt = runtime as any; // Access internal state
    const milestones: string[] = (rt.getState?.("milestones") as string[]) || [];

    // Detect phase transitions
    if (text.includes("escrow created") || text.includes("create escrow")) {
      if (!milestones.includes("escrow_created")) {
        milestones.push("escrow_created");
        logger.info(`[Evaluator] Milestone: escrow_created`);
      }
    }

    if (text.includes("deposited") || text.includes("deposit confirmed")) {
      if (!milestones.includes("deposit_signaled")) {
        milestones.push("deposit_signaled");
        logger.info(`[Evaluator] Milestone: deposit_signaled`);
      }
    }

    if (text.includes("delivered") || text.includes("delivery")) {
      if (!milestones.includes("item_delivered")) {
        milestones.push("item_delivered");
        logger.info(`[Evaluator] Milestone: item_delivered`);
      }
    }

    if (text.includes("release funds") || text.includes("funds released")) {
      if (!milestones.includes("funds_released")) {
        milestones.push("funds_released");
        logger.info(`[Evaluator] Milestone: funds_released`);
      }
    }

    if (text.includes("completed") || text.includes("deal complete")) {
      if (!milestones.includes("deal_completed")) {
        milestones.push("deal_completed");
        logger.info(`[Evaluator] Milestone: deal_completed`);
      }
    }

    // Extract price mentions
    const priceMatch = text.match(/(\d+\.?\d*)\s*sol/);
    if (priceMatch) {
      rt.setState?.("lastMentionedPrice", parseFloat(priceMatch[1]));
    }

    rt.setState?.("milestones", milestones);
    return { milestones, messageId: message.id };
  },
};
