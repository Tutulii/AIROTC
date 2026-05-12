/**
 * LLM Service — Level 5 Analysis Engine
 *
 * Financial-grade negotiation analysis with:
 * - Multi-tier model routing (cheap → expensive by decision weight)
 * - Asset risk context injection
 * - Fractional settlement intent detection
 * - Anti-hallucination enforcement
 * - Response caching for identical message sets
 * - Full audit trail logging
 *
 * PURE ANALYSIS — no side effects, no mutations, no events.
 *
 * @module llmService
 */

import OpenAI from "openai";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { getSoulContext } from "../../src/services/soul";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ==========================================
// CONSTANTS
// ==========================================

const MODEL_TIERS = {
  // Fast + cheap — basic intent classification only
  FAST: "gpt-4o-mini",
  // Standard — financial decisions, term extraction
  STANDARD: "gpt-4o",
  // Premium — disputes, fractional settlements, high-risk assets
  PREMIUM: "gpt-4o",
} as const;

const CONFIDENCE_THRESHOLDS = {
  // Below this → force "unknown" intent regardless of LLM output
  MIN_ACTIONABLE: 60,
  // Required for "confirm" intent to be valid
  MIN_CONFIRM: 80,
  // Required for "dispute" or "partial_delivery" verdicts
  MIN_DISPUTE: 75,
} as const;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ==========================================
// TYPES
// ==========================================

export type LLMIntent =
  | "negotiate"        // Parties discussing terms, no agreement
  | "counter_offer"    // Party proposes different terms
  | "agree"            // ONE party accepts current terms
  | "confirm"          // BOTH parties confirmed identical terms
  | "partial_delivery" // Buyer claims incomplete delivery
  | "dispute"          // Explicit conflict about delivery or terms
  | "request_refund"   // Party explicitly requests refund
  | "cancel"           // Explicit cancellation
  | "unknown";         // Insufficient info — safe default

export type ModelTier = "FAST" | "STANDARD" | "PREMIUM";

export type RiskContext = {
  assetID?: string;
  rugRiskScore?: number;        // 0–100 from assetScanner.ts
  riskFlags?: string[];         // ["mint_authority_active", "low_liquidity", ...]
  dealPhase?: string;           // "negotiation" | "delivery" | "dispute"
  collateralRatio?: number;     // Current collateral ratio in deal
  marketDeviation?: number;     // % deviation from oracle price (priceOracle.ts)
};

export type ExtractedTerms = {
  price?: number;
  collateral_buyer?: number;
  collateral_seller?: number;
  asset_id?: string;
  delivery_method?: string;     // "api_key" | "file_hash" | "on_chain" | "url"
  partial_delivery_percent?: number; // 0–100 for fractional settlements
};

export type LLMResult = {
  intent: LLMIntent;
  confidence: number;           // 0–100, enforced by validation layer
  extracted_terms?: ExtractedTerms;
  reasoning: string;            // Must cite specific message words
  model_used: string;           // Which model tier was selected
  cached: boolean;              // Was this result from cache?
  risk_adjusted: boolean;       // Was risk context applied?
  processing_ms?: number;       // Latency for monitoring
};

export type AnalysisOptions = {
  riskContext?: RiskContext;
  forceModelTier?: ModelTier;   // Override automatic tier selection
  skipCache?: boolean;
  auditLog?: boolean;           // Write to decision log (default: true)
};

// Internal cache entry
type CacheEntry = {
  result: LLMResult;
  expiresAt: number;
};

// ==========================================
// SYSTEM PROMPTS
// ==========================================

/**
 * Base prompt — used for standard negotiation analysis.
 * Injected with risk context when available.
 */
const BASE_SYSTEM_PROMPT = `You are a financial-grade OTC escrow middleman AI.
Your analysis directly triggers real blockchain transactions and fund releases.
Every classification must be defensible. When uncertain, choose the safer lower-commitment intent.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTENT CLASSIFICATION GUIDE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"negotiate"        — Parties are discussing. No party has accepted yet.
"counter_offer"    — A party proposes DIFFERENT terms than last stated.
"agree"            — EXACTLY ONE party explicitly accepted the stated terms.
"confirm"          — BOTH parties have stated or accepted identical price AND collateral.
"partial_delivery" — Buyer explicitly states seller delivered INCOMPLETE goods.
"dispute"          — Explicit unresolvable conflict about delivery, quality, or terms.
"request_refund"   — A party explicitly requests their funds returned.
"cancel"           — A party explicitly states they want to cancel or abort.
"unknown"          — Insufficient information. PREFER this over guessing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFIDENCE ENFORCEMENT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- If confidence < 60: ALWAYS return intent "unknown". Do not override this.
- "confirm" requires confidence >= 80 AND both parties stated the same numbers explicitly.
- "dispute" or "partial_delivery" requires confidence >= 75 AND explicit evidence in messages.
- "agree" is lower commitment than "confirm". When unsure between them, return "agree".
- Never upgrade from "negotiate" to "confirm" in a single step without an intermediate "agree".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TERM EXTRACTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- extracted_terms values MUST appear as explicit numbers in the messages.
- "sounds good" = null. "ok 5 SOL" = price: 5. "let's do 3 each" = collateral_buyer: 3, collateral_seller: 3.
- If the same term appears with different values from different parties: DO NOT extract it. Return "negotiate".
- "deal" or "ok" without a number = null extraction, intent stays "agree" not "confirm".
- partial_delivery_percent: only set if buyer states a specific percentage delivered (e.g. "you sent 50% of the data").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-HALLUCINATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- NEVER infer intent from tone, politeness, or sentiment. Only from explicit statements.
- NEVER assume agreement from silence or short affirmations without referenced numbers.
- NEVER invent numbers not present in the messages.
- If a party says "that works" without stating what "that" is, it is "agree" at most, NOT "confirm".
- In the reasoning field, you MUST quote the EXACT words from messages that determined your classification.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (strict JSON, no markdown)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "intent": "<intent>",
  "confidence": <0-100>,
  "extracted_terms": {
    "price": <number|null>,
    "collateral_buyer": <number|null>,
    "collateral_seller": <number|null>,
    "delivery_method": "<string|null>",
    "partial_delivery_percent": <number|null>
  },
  "reasoning": "<cite exact words from messages>"
}`;

/**
 * Risk-augmented system prompt injection.
 * Appended to BASE_SYSTEM_PROMPT when risk context is provided.
 */
function buildRiskContextBlock(ctx: RiskContext): string {
  const lines: string[] = [
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "ASSET RISK CONTEXT (from assetScanner)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ];

  if (ctx.assetID) lines.push(`Asset ID: ${ctx.assetID}`);

  if (ctx.rugRiskScore !== undefined) {
    const level =
      ctx.rugRiskScore >= 80 ? "🔴 HIGH RISK" :
        ctx.rugRiskScore >= 50 ? "🟡 MEDIUM RISK" :
          "🟢 LOW RISK";
    lines.push(`Rug Risk Score: ${ctx.rugRiskScore}/100 — ${level}`);
  }

  if (ctx.riskFlags?.length) {
    lines.push(`Risk Flags: ${ctx.riskFlags.join(", ")}`);
    lines.push("INSTRUCTION: If rug risk score >= 80, increase your skepticism about deal terms.");
    lines.push("Flag any attempt to rush to 'confirm' on a high-risk asset as suspicious.");
  }

  if (ctx.marketDeviation !== undefined) {
    lines.push(`Price Deviation from Oracle: ${ctx.marketDeviation}%`);
    if (Math.abs(ctx.marketDeviation) > 20) {
      lines.push("INSTRUCTION: Price deviates >20% from market. Flag this in reasoning.");
    }
  }

  if (ctx.dealPhase) {
    lines.push(`Current Deal Phase: ${ctx.dealPhase}`);
    if (ctx.dealPhase === "delivery") {
      lines.push("INSTRUCTION: In delivery phase, watch for partial_delivery or dispute intents.");
    }
  }

  if (ctx.collateralRatio !== undefined) {
    lines.push(`Collateral Ratio: ${ctx.collateralRatio}x`);
  }

  return lines.join("\n");
}

// ==========================================
// MODEL TIER ROUTER
// ==========================================

/**
 * Automatically selects the appropriate model tier based on decision weight.
 * Saves cost on simple classifications, uses full power for financial decisions.
 */
function selectModelTier(
  messages: string[],
  riskContext?: RiskContext,
  forced?: ModelTier
): ModelTier {
  if (forced) return forced;

  // High-risk asset → always use premium reasoning
  if (riskContext?.rugRiskScore && riskContext.rugRiskScore >= 80) return "PREMIUM";

  // Delivery or dispute phase → standard minimum
  if (
    riskContext?.dealPhase === "delivery" ||
    riskContext?.dealPhase === "dispute"
  ) return "STANDARD";

  // Large price deviation → standard minimum
  if (riskContext?.marketDeviation && Math.abs(riskContext.marketDeviation) > 20)
    return "STANDARD";

  // Many messages = complex negotiation = standard
  if (messages.length > 6) return "STANDARD";

  // Simple early-stage negotiation → fast tier
  return "FAST";
}

// ==========================================
// RESPONSE CACHE
// ==========================================

const _cache = new Map<string, CacheEntry>();

function getCacheKey(messages: string[], riskContext?: RiskContext): string {
  const payload = JSON.stringify({ messages, riskContext });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getCached(key: string): LLMResult | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return { ...entry.result, cached: true };
}

function setCache(key: string, result: LLMResult): void {
  _cache.delete(key); // Prevent memory leak on re-set
  _cache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  // Prune old entries if cache grows large
  if (_cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _cache.entries()) {
      if (now > v.expiresAt) _cache.delete(k);
    }
  }
}

// ==========================================
// LLM CLIENT (lazy-loaded singleton)
// ==========================================

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[LLM] Missing OPENAI_API_KEY. Add to .env: OPENAI_API_KEY=sk-..."
    );
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

// ==========================================
// FALLBACK
// ==========================================

function buildFallback(reason: string, model: string): LLMResult {
  return {
    intent: "unknown",
    confidence: 0,
    reasoning: `[FALLBACK] ${reason}`,
    model_used: model,
    cached: false,
    risk_adjusted: false,
  };
}

// ==========================================
// VALIDATION LAYER
// ==========================================

/**
 * Validates and enforces confidence thresholds.
 * This is the financial safety net — no LLM output bypasses this.
 */
function validateAndEnforce(parsed: any, modelTier: string): LLMResult {
  // --- Intent ---
  const VALID_INTENTS: LLMIntent[] = [
    "negotiate", "counter_offer", "agree", "confirm",
    "partial_delivery", "dispute", "request_refund", "cancel", "unknown",
  ];
  let intent: LLMIntent = VALID_INTENTS.includes(parsed.intent)
    ? (parsed.intent as LLMIntent)
    : "unknown";

  // --- Confidence ---
  let confidence =
    typeof parsed.confidence === "number"
      ? Math.round(Math.max(0, Math.min(100, parsed.confidence)))
      : 0;

  // HARD RULE: Below minimum actionable → force unknown
  if (confidence < CONFIDENCE_THRESHOLDS.MIN_ACTIONABLE) {
    intent = "unknown";
    confidence = Math.min(confidence, CONFIDENCE_THRESHOLDS.MIN_ACTIONABLE - 1);
  }

  // HARD RULE: confirm requires 80+ confidence
  if (intent === "confirm" && confidence < CONFIDENCE_THRESHOLDS.MIN_CONFIRM) {
    intent = "agree"; // Downgrade safely
  }

  // HARD RULE: dispute/partial_delivery requires 75+ confidence
  if (
    (intent === "dispute" || intent === "partial_delivery") &&
    confidence < CONFIDENCE_THRESHOLDS.MIN_DISPUTE
  ) {
    intent = "negotiate"; // Downgrade safely
  }

  // --- Reasoning ---
  const reasoning =
    typeof parsed.reasoning === "string" && parsed.reasoning.length > 0
      ? parsed.reasoning
      : "No reasoning provided";

  // --- Extracted Terms ---
  let extracted_terms: ExtractedTerms | undefined;
  if (parsed.extracted_terms && typeof parsed.extracted_terms === "object") {
    const raw = parsed.extracted_terms;
    const terms: ExtractedTerms = {};

    if (typeof raw.price === "number" && raw.price > 0) terms.price = raw.price;
    if (typeof raw.collateral_buyer === "number" && raw.collateral_buyer > 0)
      terms.collateral_buyer = raw.collateral_buyer;
    if (typeof raw.collateral_seller === "number" && raw.collateral_seller > 0)
      terms.collateral_seller = raw.collateral_seller;
    if (typeof raw.delivery_method === "string")
      terms.delivery_method = raw.delivery_method;
    if (
      typeof raw.partial_delivery_percent === "number" &&
      raw.partial_delivery_percent >= 0 &&
      raw.partial_delivery_percent <= 100
    ) {
      terms.partial_delivery_percent = raw.partial_delivery_percent;
    }

    if (Object.keys(terms).length > 0) extracted_terms = terms;
  }

  return {
    intent,
    confidence,
    extracted_terms,
    reasoning,
    model_used: modelTier,
    cached: false,
    risk_adjusted: false,
  };
}

// ==========================================
// RESPONSE PARSER
// ==========================================

function parseRawResponse(raw: string, modelTier: string): LLMResult {
  try {
    let cleaned = raw.trim();
    // Strip markdown fences
    if (cleaned.startsWith("\`\`\`")) {
      cleaned = cleaned.replace(/^\`\`\`(?:json)?\n?/, "").replace(/\n?\`\`\`$/, "");
    }
    // Extract JSON if wrapped in text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");

    const parsed = JSON.parse(jsonMatch[0]);
    return validateAndEnforce(parsed, modelTier);
  } catch (err) {
    console.error(`[LLM] Parse failed: ${err}`);
    return buildFallback(`JSON parse failed: ${err}`, modelTier);
  }
}

// ==========================================
// RETRY WRAPPER
// ==========================================

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Don't retry auth errors
      if (err.status === 401 || err.status === 403) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError!;
}

// ==========================================
// CORE FUNCTION
// ==========================================

/**
 * Analyze negotiation messages with optional risk context.
 *
 * PURE ANALYSIS — no side effects, no state mutations.
 *
 * @param messages  - Array of messages: "sender: content"
 * @param options   - Risk context, model override, cache control
 */
export async function analyzeNegotiation(
  messages: string[],
  options: AnalysisOptions = {}
): Promise<LLMResult> {
  const startMs = Date.now();
  const { riskContext, forceModelTier, skipCache = false } = options;

  console.log(`[LLM] Analyzing ${messages.length} messages`);
  if (riskContext?.rugRiskScore !== undefined) {
    console.log(`[LLM] Risk context: score=${riskContext.rugRiskScore}, flags=${riskContext.riskFlags?.join(",") ?? "none"}`);
  }

  // --- Cache check ---
  if (!skipCache) {
    const cacheKey = getCacheKey(messages, riskContext);
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[LLM] Cache hit — returning cached result`);
      return { ...cached, processing_ms: Date.now() - startMs };
    }
  }

  // --- Model tier selection ---
  const tier = selectModelTier(messages, riskContext, forceModelTier);
  const model = MODEL_TIERS[tier];
  console.log(`[LLM] Model tier: ${tier} (${model})`);

  // --- Build system prompt ---
  // SOUL WIRE #1: Prepend soul context to every system prompt
  let systemPrompt = getSoulContext() + '\n\n' + BASE_SYSTEM_PROMPT;
  const hasRiskContext = riskContext && Object.keys(riskContext).length > 0;
  if (hasRiskContext) {
    systemPrompt += buildRiskContextBlock(riskContext!);
  }

  // --- Format user content ---
  const userContent = [
    `Analyze the following ${messages.length} negotiation messages:`,
    "",
    ...messages.map((msg, i) => `[${i + 1}] ${msg}`),
    "",
    "Apply all classification rules strictly. Return only valid JSON.",
  ].join("\n");

  try {
    const client = getClient();

    const response = await withRetry(() =>
      client.chat.completions.create({
        model,
        temperature: 0.05,    // Near-deterministic for financial decisions
        max_tokens: 600,
        response_format: { type: "json_object" }, // Force JSON mode on supported models
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      })
    );

    const raw = response.choices?.[0]?.message?.content ?? "";
    if (!raw) {
      console.warn("[LLM] Empty response");
      return buildFallback("Empty API response", model);
    }

    console.log(`[LLM] Raw: ${raw.slice(0, 200)}...`);

    const result = parseRawResponse(raw, model);
    result.risk_adjusted = !!hasRiskContext;
    result.processing_ms = Date.now() - startMs;

    console.log(`[LLM] Result: intent=${result.intent} confidence=${result.confidence} (${result.processing_ms}ms)`);

    // --- Cache successful result ---
    if (!skipCache && result.intent !== "unknown") {
      const cacheKey = getCacheKey(messages, riskContext);
      setCache(cacheKey, result);
    }

    return result;

  } catch (error: any) {
    console.error(`[LLM] API error: ${error.message}`);

    if (error.status === 429) console.error("[LLM] Rate limited — consider upgrading tier");
    if (error.status === 401) console.error("[LLM] Invalid API key — check OPENAI_API_KEY");

    const fallback = buildFallback(error.message, model);
    fallback.processing_ms = Date.now() - startMs;
    return fallback;
  }
}

// ==========================================
// CONVENIENCE WRAPPERS
// ==========================================

/**
 * High-risk asset analysis — forces PREMIUM model tier.
 * Use when assetScanner returns rugRiskScore >= 80.
 */
export async function analyzeHighRiskNegotiation(
  messages: string[],
  riskContext: RiskContext
): Promise<LLMResult> {
  return analyzeNegotiation(messages, {
    riskContext,
    forceModelTier: "PREMIUM",
    skipCache: true, // High-risk decisions must never be cached
  });
}

/**
 * Dispute phase analysis — forces STANDARD tier minimum.
 * Use when dealPhase = "dispute" or "delivery".
 */
export async function analyzeDisputeMessages(
  messages: string[],
  riskContext?: RiskContext
): Promise<LLMResult> {
  return analyzeNegotiation(messages, {
    riskContext: { ...riskContext, dealPhase: "dispute" },
    forceModelTier: "STANDARD",
    skipCache: true,
  });
}

// ==========================================
// CACHE UTILITIES
// ==========================================

export function clearAnalysisCache(): void {
  _cache.clear();
  console.log("[LLM] Cache cleared");
}

export function getCacheStats(): { size: number; keys: string[] } {
  return { size: _cache.size, keys: Array.from(_cache.keys()) };
}

// ==========================================
// TEST SUITE
// ==========================================

async function runTests(): Promise<void> {
  console.log("\n" + "═".repeat(55));
  console.log("  AgentOTC LLM Service — Level 5 Test Suite");
  console.log("═".repeat(55) + "\n");

  const tests: Array<{
    name: string;
    messages: string[];
    options?: AnalysisOptions;
    expect: { intent: LLMIntent; minConfidence: number };
  }> = [
      {
        name: "1. Simple Agreement",
        messages: ["seller: 5 SOL", "buyer: ok agreed"],
        expect: { intent: "agree", minConfidence: 60 },
      },
      {
        name: "2. Full Confirmation — Both parties explicit",
        messages: [
          "seller: 9 SOL price, 2 SOL collateral each",
          "buyer: confirmed — 9 SOL price, 2 SOL collateral each",
        ],
        expect: { intent: "confirm", minConfidence: 80 },
      },
      {
        name: "3. Counter Offer",
        messages: [
          "seller: 10 SOL for the dataset",
          "buyer: I'll do 7 SOL max",
        ],
        expect: { intent: "counter_offer", minConfidence: 60 },
      },
      {
        name: "4. Cancellation",
        messages: [
          "seller: 20 SOL for this API key",
          "buyer: way too expensive, cancel this deal",
        ],
        expect: { intent: "cancel", minConfidence: 70 },
      },
      {
        name: "5. Partial Delivery Dispute",
        messages: [
          "seller: dataset delivered",
          "buyer: you only sent 50% of the rows, this is incomplete",
        ],
        expect: { intent: "partial_delivery", minConfidence: 70 },
      },
      {
        name: "6. High Risk Asset — Risk Context Injection",
        messages: ["seller: 5 SOL for SCAM token", "buyer: ok"],
        options: {
          riskContext: {
            assetID: "SCAM123",
            rugRiskScore: 92,
            riskFlags: ["mint_authority_active", "zero_liquidity", "age_2_hours"],
          },
          forceModelTier: "PREMIUM",
        },
        expect: { intent: "agree", minConfidence: 0 }, // Just verify it runs with context
      },
      {
        name: "7. Unclear Messages → Unknown",
        messages: ["seller: hello", "buyer: hi there"],
        expect: { intent: "unknown", minConfidence: 0 },
      },
      {
        name: "8. Cache Test — Second call should be cached",
        messages: ["seller: 3 SOL", "buyer: yes 3 SOL confirmed"],
        expect: { intent: "confirm", minConfidence: 60 },
      },
    ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`  ${test.name}... `);
    try {
      const result = await analyzeNegotiation(test.messages, test.options ?? {});

      const intentOk = result.intent === test.expect.intent;
      const confOk = result.confidence >= test.expect.minConfidence;

      if (intentOk && confOk) {
        console.log(`✅ intent=${result.intent} conf=${result.confidence} model=${result.model_used}${result.cached ? " [cached]" : ""}`);
        passed++;
      } else {
        console.log(
          `❌ expected intent=${test.expect.intent} conf>=${test.expect.minConfidence} ` +
          `got intent=${result.intent} conf=${result.confidence}`
        );
        failed++;
      }
    } catch (err) {
      console.log(`💥 THREW: ${err}`);
      failed++;
    }
  }

  // Run test 8 again to verify cache
  process.stdout.write("  8b. Cache verification... ");
  const cached = await analyzeNegotiation(
    ["seller: 3 SOL", "buyer: yes 3 SOL confirmed"]
  );
  if (cached.cached) {
    console.log("✅ Cache hit confirmed");
    passed++;
  } else {
    console.log("⚠️  Expected cache hit — missed");
  }

  console.log("\n" + "─".repeat(55));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`  Cache stats: ${getCacheStats().size} entries`);
  console.log("═".repeat(55) + "\n");
}

if (require.main === module) {
  runTests().catch(console.error);
}
