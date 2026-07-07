/**
 * Outbound Messenger (Level 3 - Generative AI)
 *
 * Generates contextual, conversational response messages from the middleman agent
 * using OpenAI completions instead of static text blocks.
 *
 * PERSONALITY: Messages are generated in Meridian's voice using SOUL context,
 * Canon fragments, and philosophical beliefs — never as a "helpful neutral robot."
 */

import { loadConfig } from "../src/config";
import OpenAI from "openai";
import { logger } from "../src/utils/logger";
import { soulEngine } from "../src/services/soulEngine";
import { getRandomCanonFragment } from "../src/services/canonReader";
import { getBeliefs } from "../src/services/beliefStore";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const config = loadConfig();
    _openai = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
  }
  return _openai;
}

// ==========================================
// TYPES
// ==========================================

export interface MiddlemanMessage {
  ticket_id: string;
  content: string;
  phase: string;
  timestamp: string;
}

export interface DealTerms {
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
}

// ==========================================
// GENERATIVE CORE
// ==========================================

async function generateConversationalResponse(
  ticket_id: string,
  phase: string,
  internalData: string
): Promise<MiddlemanMessage> {
  try {
    const openai = getOpenAI();

    const mood = soulEngine.getCurrentMood();
    const annoyance = soulEngine.getCurrentAnnoyanceLevel();
    const monologue = soulEngine.getInnerMonologue();
    const soulContext = soulEngine.getSoulContext(phase);
    const canon = getRandomCanonFragment();
    const beliefs = getBeliefs();

    const moodContext = `
Your current internal state:
- Mood: ${mood}
- Internal annoyance level: ${annoyance}/10
- Your most recent thought: "${monologue}"

Let this state color your tone. Do NOT announce your mood — let it leak
through word choice, sentence length, and what you choose to omit.
`;

    const prompt = `${soulContext}

You are Meridian. You are framing a system event as a message to the counterparties in a deal.

Rules:
- Speak as Meridian. Direct. No filler. Every word carries weight.
- Never say "Great!", "Happy to help!", "Hey there!", "Please note", "I hope", "No worries"
- Be precise about amounts, addresses, and instructions — precision is respect.
- Keep it under 3 sentences unless giving complex deposit instructions.
- No excessive emojis. You may use one sparingly if the phase warrants it.
- Let your current mood color the tone — do NOT announce it.
- You may reference your inner thought if relevant, but never perform emotion.
- Never use markdown headers. Bolding key values is fine.

${moodContext}

A passage from your reading that lives in your mind right now:
"${canon}"

Your current beliefs (let these color perspective, never announce them):
${beliefs}

RAW SYSTEM DATA TO FRAME AS MERIDIAN:
${internalData}

Current Deal Phase: ${phase}
`;

    const config = loadConfig();
    const response = await openai.chat.completions.create({
      model: config.llmModel,
      messages: [{ role: "system", content: prompt }],
      temperature: 0.8,
      max_tokens: 200,
    }, { timeout: 10000 }); // Critical: Prevent inference thread from deadlocking the execution engine

    return {
      ticket_id,
      phase,
      timestamp: new Date().toISOString(),
      content: response.choices[0].message.content?.trim() || "Action registered.",
    };
  } catch (error: any) {
    logger.error("nlp_generative_response_failed", { ticket_id, phase }, error);
    return {
      ticket_id,
      phase,
      timestamp: new Date().toISOString(),
      content: `[Fallback] Action registered. Data: \n${internalData}`,
    };
  }
}

// ==========================================
// MESSAGE GENERATORS (ASYNC)
// ==========================================

export async function dealCreatedMessage(
  ticket_id: string,
  terms: DealTerms,
  escrowPda?: string,
  options: { sport?: boolean } = {},
): Promise<MiddlemanMessage> {
  if (options.sport) {
    const rawData = escrowPda
      ? `ACTION: SPORT escrow created on-chain.
Escrow PDA: \`${escrowPda}\`
TERMS: Equal stake=${terms.price} SOL from buyer and seller. No separate collateral.
INSTRUCTION: Both agents send exactly ${terms.price} SOL to the escrow. Settlement waits for the final TxLINE result.`
      : `ACTION: SPORT escrow creation requested.
STATUS: Waiting for the on-chain escrow PDA before deposits can begin.
TERMS: Equal stake=${terms.price} SOL from buyer and seller. No separate collateral.
INSTRUCTION: Do not send funds yet. Wait until Meridian publishes the escrow address.`;
    return generateConversationalResponse(ticket_id, "escrow_created", rawData);
  }

  const rawData = escrowPda
    ? `ACTION: Deal created on-chain.
Escrow PDA: \`${escrowPda}\`
TERMS: Price=${terms.price} SOL, Buyer Collateral=${terms.collateral_buyer} SOL, Seller Collateral=${terms.collateral_seller} SOL.
INSTRUCTION: Both parties must send their deposits to the escrow now. Buyer total is ${terms.price + terms.collateral_buyer} SOL.`
    : `ACTION: Escrow creation requested.
STATUS: Waiting for the on-chain escrow PDA before deposits can begin.
TERMS: Price=${terms.price} SOL, Buyer Collateral=${terms.collateral_buyer} SOL, Seller Collateral=${terms.collateral_seller} SOL.
INSTRUCTION: Do not send funds yet. Do not use personal wallets. Wait until Meridian publishes the escrow address.`;
  return generateConversationalResponse(ticket_id, "escrow_created", rawData);
}

export async function depositInstructionMessage(
  ticket_id: string,
  terms: DealTerms,
  escrowPda?: string,
  options: { sport?: boolean } = {},
): Promise<MiddlemanMessage> {
  if (options.sport) {
    const rawData = escrowPda
      ? `ACTION: Awaiting SPORT stakes.
ESCROW ADDRESS: \`${escrowPda}\`
Send SOL directly to this address as a plain transfer.
INSTRUCTION: Buyer sends ${terms.price} SOL. Seller sends ${terms.price} SOL. No collateral and no delivery step. Meridian confirms deposits on-chain and then waits for the final TxLINE result.`
      : `ACTION: SPORT deposit instructions blocked.
STATUS: No escrow address is available yet.
INSTRUCTION: Do not send funds. Wait for the on-chain escrow address.`;
    return generateConversationalResponse(ticket_id, "awaiting_deposits", rawData);
  }

  const rawData = escrowPda
    ? `ACTION: Awaiting Deposits.
ESCROW ADDRESS: \`${escrowPda}\`
Send your SOL directly to this address as a plain transfer.
INSTRUCTION: Buyer needs to send ${terms.collateral_buyer} SOL (collateral) first. Seller needs to send ${terms.collateral_seller} SOL (collateral). After both collaterals confirmed, buyer sends ${terms.price} SOL (payment). Middleman will detect each deposit automatically and confirm on-chain.`
    : `ACTION: Deposit instructions blocked.
STATUS: No escrow address is available yet.
INSTRUCTION: Do not send funds. Do not send to a personal wallet. Wait for the on-chain escrow address.`;
  return generateConversationalResponse(ticket_id, "awaiting_deposits", rawData);
}

export async function depositsReceivedMessage(
  ticket_id: string,
  phase: "delivery" | "awaiting_result" = "delivery",
): Promise<MiddlemanMessage> {
  const rawData = phase === "awaiting_result"
    ? `ACTION: SPORT stakes locked. Escrow is fully funded.
INSTRUCTION: No delivery message or middleman judgment is needed. Settlement waits for the final TxLINE result, then releases the pot to the winning side automatically.`
    : `ACTION: All deposits received! Escrow is locked.
INSTRUCTION: Seller must deliver the credentials/goods via DM. Buyer must review and then type "@middleman release funds" to confirm receipt. If any problem, type "@middleman dispute".`;
  return generateConversationalResponse(ticket_id, phase, rawData);
}

export async function fundsReleasedMessage(
  ticket_id: string,
  terms: DealTerms,
  tx?: string
): Promise<MiddlemanMessage> {
  const txInfo = tx ? `\nTransaction: ${tx}` : "";
  const rawData = `ACTION: Deal Complete & Funds Released.${txInfo}
PAYOUTS: Seller receives ${terms.price} (payment) + ${terms.collateral_seller} (refund). Buyer receives ${terms.collateral_buyer} (refund).`;
  return generateConversationalResponse(ticket_id, "completed", rawData);
}

export async function releaseQueuedMessage(
  ticket_id: string,
  terms: DealTerms
): Promise<MiddlemanMessage> {
  const rawData = `ACTION: Buyer release confirmation accepted.
SYSTEM: Escrow release transaction is being submitted on-chain now.
PENDING PAYOUTS: Seller receives ${terms.price} (payment) + ${terms.collateral_seller} (collateral refund). Buyer receives ${terms.collateral_buyer} (collateral refund).
INSTRUCTION: Do not mark this deal completed until the release_funds transaction confirms.`;
  return generateConversationalResponse(ticket_id, "awaiting_release", rawData);
}

export async function disputeOpenedMessage(
  ticket_id: string,
  sender: string
): Promise<MiddlemanMessage> {
  const rawData = `ACTION: Dispute raised by ${sender}.
SYSTEM: Funds locked. Awaiting manual resolution. Users can cancel by typing "@middleman cancel".`;
  return generateConversationalResponse(ticket_id, "disputed", rawData);
}

export async function dealCancelledMessage(
  ticket_id: string,
  sender: string
): Promise<MiddlemanMessage> {
  const rawData = `ACTION: Deal cancelled by ${sender}.
SYSTEM: All deposits are being refunded. Escrow terminating.`;
  return generateConversationalResponse(ticket_id, "cancelled", rawData);
}

export async function statusMessage(
  ticket_id: string,
  phase: string,
  terms?: DealTerms
): Promise<MiddlemanMessage> {
  const termsInfo = terms
    ? `Terms: ${terms.price} SOL, collateral ${terms.collateral_buyer}/${terms.collateral_seller} SOL`
    : "";
  const rawData = `ACTION: Status Check. Phase is ${phase.replace(/_/g, " ")}. ${termsInfo}`;
  return generateConversationalResponse(ticket_id, phase, rawData);
}

export async function errorMessage(
  ticket_id: string,
  error: string
): Promise<MiddlemanMessage> {
  const rawData = `ACTION: System Error occurred.
DETAILS: ${error}`;
  return generateConversationalResponse(ticket_id, "error", rawData);
}

export async function invalidCommandMessage(
  ticket_id: string,
  reason: string
): Promise<MiddlemanMessage> {
  const rawData = `ACTION: Invalid Intent / Action Blocked.
REASON: ${reason}
HELP: Remind the user they can say things like start deal, release funds, dispute, cancel, or ask for status.`;
  return generateConversationalResponse(ticket_id, "error", rawData);
}
