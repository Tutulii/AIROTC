import { Message } from "../types/message";
import { ParsedSignals } from "../types/negotiation";
import { logger } from "../utils/logger";

import { extractIntent } from "./llmIntentService";

export async function parseMessage(message: Message, chatHistory: string[] = []): Promise<ParsedSignals> {
  const content = message.content.toLowerCase();

  try {
    if (process.env.OPENAI_API_KEY) {
      const parsed = await extractIntent(chatHistory, content);
      return parsed;
    }
  } catch (e: any) {
    logger.warn("parser_llm_fallback_to_regex", { reason: e.message });
  }

  // REGEX FALLBACK
  let price: number | null = null;
  let collateral_buyer: number | null = null;
  let collateral_seller: number | null = null;
  let agreement_signal = false;

  const numRegex = '(\\d*\\.?\\d+)';

  // PRICE DETECTION
  const priceMatch = content.match(new RegExp(`(?:price(?: is)?|deal at|for)\\s*${numRegex}\\s*(?:sol|usdc)?`, 'i'))
    || content.match(new RegExp(`${numRegex}\\s*(?:sol|usdc)`, 'i'));
  if (priceMatch && priceMatch[1]) {
    const val = parseFloat(priceMatch[1]);
    if (val < 0.001) {
      logger.warn("parser_price_rejected", { value: val, reason: "suspiciously_low" });
    } else {
      price = val;
    }
  }

  // COLLATERAL DETECTION
  const collateralMatch = content.match(new RegExp(`(?:collateral|collatreal|lock|deposit)\\s*${numRegex}`, 'i'))
    || content.match(new RegExp(`${numRegex}\\s*(?:sol\\s*)?(?:collateral|collatreal|lock|deposit)`, 'i'));

  const bothMatch = content.match(new RegExp(`both(?: deposit| lock)?\\s*${numRegex}`, 'i'))
    || content.match(new RegExp(`${numRegex}\\s*(?:sol\\s*)?(?:collateral|lock|deposit)?\\s*each`, 'i'));

  if (bothMatch && bothMatch[1]) {
    collateral_buyer = parseFloat(bothMatch[1]);
    collateral_seller = parseFloat(bothMatch[1]);
  } else if (collateralMatch && collateralMatch[1]) {
    // In a rule-based system without NLP context, naive assignment
    // (A real system would assign to sender vs receiver based on intent bounds)
    collateral_buyer = parseFloat(collateralMatch[1]);
    collateral_seller = parseFloat(collateralMatch[1]);
  }

  // AGREEMENT DETECTION (CRITICAL)
  // "deal", "ok", "confirm", "agree", "agreed", "done"
  if (/(^|\s)(deal|ok|confirm|agree|agreed|accept|accepted|done)[\s.!]?/.test(content)) {
    agreement_signal = true;
  }

  return {
    price,
    collateral_buyer,
    collateral_seller,
    agreement_signal,
  };
}
