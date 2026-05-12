export interface ParsedResult {
  price: number | null;
  collateral_buyer: number | null;
  collateral_seller: number | null;
  asset_keywords: string[] | null;
  agreement_score: number;
  raw_text: string;
}

/**
 * Helper to normalize numbers in text (e.g. "one point five" -> "1.5")
 */
function normalizeNumbers(text: string): string {
  return text.toLowerCase()
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4')
    .replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7')
    .replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9')
    .replace(/\bten\b/g, '10')
    .replace(/\bpoint\b/g, '.')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
    .replace(/\s+/g, ' '); // collapse spaces
}

/**
 * Extracts price from text by searching for common price patterns.
 * Handles variants like lamports and word representations.
 */
export function extractPrice(text: string): number | null {
  const normalizedText = normalizeNumbers(text);

  // Check for lamports first (1 SOL = 1,000,000,000 lamports)
  const lamportMatch = normalizedText.match(/(\d+(?:\.\d+)?)\s*lamports/i);
  if (lamportMatch) {
    return parseFloat(lamportMatch[1]) / 1_000_000_000;
  }

  const patterns = [
    /price[-:\s]*(\d+(?:\.\d+)?)/i,
    /deal at\s*(\d+(?:\.\d+)?)/i,
    /selling for\s*(\d+(?:\.\d+)?)/i,
    /agree on\s*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*(?:sol|solana)/i
  ];

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (match && match[1]) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val > 0) {
        return val;
      }
    }
  }

  return null;
}

/**
 * Extracts collateral terms from text.
 * Handles natural phrases like "I'll lock", "you deposit", and shared values.
 */
export function extractCollateral(text: string): { buyer: number | null, seller: number | null } {
  const normalizedText = normalizeNumbers(text);

  let meCollateral: number | null = null;
  let youCollateral: number | null = null;

  const mePatterns = [
    /(?:i|i'll|ill|i will)\s*(?:deposit|lock|put|provide)\s*(\d+(?:\.\d+)?)/i,
    /my\s*collateral\s*(?:is|will be)?\s*(\d+(?:\.\d+)?)/i,
    /collateral from me\s*(\d+(?:\.\d+)?)/i
  ];

  const youPatterns = [
    /(?:you|you'll|youll|you will)\s*(?:deposit|lock|put|provide)\s*(\d+(?:\.\d+)?)/i,
    /your\s*collateral\s*(?:is|will be)?\s*(\d+(?:\.\d+)?)/i,
    /collateral from you\s*(\d+(?:\.\d+)?)/i
  ];

  for (const p of mePatterns) {
    const match = normalizedText.match(p);
    if (match) { meCollateral = parseFloat(match[1]); break; }
  }

  for (const p of youPatterns) {
    const match = normalizedText.match(p);
    if (match) { youCollateral = parseFloat(match[1]); break; }
  }

  // If we found any explicit "me" or "you" collateral, return it
  if (meCollateral !== null || youCollateral !== null) {
    return { buyer: meCollateral, seller: youCollateral };
  }

  // Fallback to shared / single deposit values
  const bothPatterns = [
    /both\s*(?:deposit|lock|put)\s*(\d+(?:\.\d+)?)/i,
    /each\s*(?:deposit|lock|put)\s*(\d+(?:\.\d+)?)/i,
    /deposit\s*(\d+(?:\.\d+)?)\s*(?:each|both)/i,
    /collateral[-:\s]*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*(?:sol\s+)?collateral/i,
    /lock\s*(\d+(?:\.\d+)?)\s*sol/i
  ];

  for (const pattern of bothPatterns) {
    const singleMatch = normalizedText.match(pattern);
    if (singleMatch && singleMatch[1]) {
      const val = parseFloat(singleMatch[1]);
      if (!isNaN(val) && val > 0) {
        return { buyer: val, seller: val };
      }
    }
  }

  return { buyer: null, seller: null };
}

/**
 * Extracts asset keywords from raw chat text.
 */
export function extractKeywords(text: string): string[] | null {
  const allowedKeywords = ['dataset', 'gpu', 'access', 'account', 'airdrop', 'nft'];
  const results = new Set<string>();
  const normalizedText = text.toLowerCase();

  for (const keyword of allowedKeywords) {
    const rx = new RegExp(`\\b${keyword}\\b`, 'g');
    if (rx.test(normalizedText)) {
      results.add(keyword);
    }
  }

  return results.size > 0 ? Array.from(results) : null;
}

/**
 * Calculates the agreement score based on keyword signals.
 * Context-aware: can accept an array of messages or a newline-separated string.
 * Caps at 100.
 */
export function calculateAgreementScore(input: string | string[]): number {
  let score = 0;

  // Normalize into an array of message strings to support context-awareness
  const messages = Array.isArray(input)
    ? input.map(m => m.toLowerCase())
    : input.toLowerCase().split('\n').filter(m => m.trim().length > 0);

  const strongSignals = ['confirm', 'confirmed', 'agree', 'accept', 'accepted', 'final', 'done', 'let\'s do', 'lets do'];
  const mediumSignals = ['ok', 'deal', 'yes', 'sounds good'];
  const weakSignals = ['fine', 'sure', 'alright'];

  let signalCount = 0;

  for (const text of messages) {
    for (const sig of strongSignals) {
      if (text.includes(sig)) { score += 40; signalCount++; }
    }
    for (const sig of mediumSignals) {
      if (text.includes(sig)) { score += 25; signalCount++; }
    }
    for (const sig of weakSignals) {
      if (text.includes(sig)) { score += 10; signalCount++; }
    }
  }

  // Context bonus: if we have multiple conversational turns agreeing, boost score
  if (messages.length > 1 && signalCount >= 2) {
    score += 20;
  }

  return Math.min(score, 100);
}

/**
 * Parses raw chat message text (or history) to extract structured deal terms.
 * Pure function.
 */
export function parseMessage(content: string | string[]): ParsedResult {
  // If array is provided, join it to extract singular values like price across the whole history
  const fullText = Array.isArray(content) ? content.join('\n') : content;

  const price = extractPrice(fullText);
  const collateral = extractCollateral(fullText);
  const asset_keywords = extractKeywords(fullText);
  const agreement_score = calculateAgreementScore(content);

  return {
    price,
    collateral_buyer: collateral.buyer,
    collateral_seller: collateral.seller,
    asset_keywords,
    agreement_score,
    raw_text: fullText
  };
}

/**
 * Test function to validate the parser.
 */
export function runParserTests() {
  const testMessages = [
    // Original tests
    "deal at 5 sol, collateral 2",
    "I agree, let's do 3 sol both deposit 1",
    "final 2.5 sol confirmed",

    // New complex test cases
    "User A: 1500000000 lamports for the dataset\nUser B: ok, i'll lock 1 sol and you lock 2 sol",
    "Buyer: one point five sol for gpu access\nSeller: sounds good, agreed",
    ["what about 1 sol?", "sure, i will deposit 0.5", "sounds good, let's do it"]
  ];

  for (const msg of testMessages) {
    const result = parseMessage(msg);
    console.log({
      input: msg,
      output: result
    });
  }
}

if (require.main === module) {
  runParserTests();
}
