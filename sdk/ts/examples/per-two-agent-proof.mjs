import { AgentOTC } from "../dist/index.js";
import bs58 from "bs58";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  throw new Error(`Missing required environment variable: one of ${names.join(", ")}`);
}

function parseSecretKey(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return Uint8Array.from(JSON.parse(trimmed));

  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length >= 32) return decoded;
  } catch {
    // fall through to base64
  }

  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length >= 32) return new Uint8Array(base64);
  throw new Error("Unsupported private key format. Use base58, base64, or JSON array secret keys.");
}

function normalizePrivateKey(raw) {
  return bs58.encode(parseSecretKey(raw));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function createClient(walletPrivateKey) {
  return new AgentOTC({
    walletPrivateKey,
    apiUrl: process.env.AIROTC_PROOF_API_URL || process.env.AIR_OTC_API_URL || "http://localhost:3000",
    wsUrl: process.env.AIROTC_PROOF_WS_URL || process.env.AIR_OTC_WS_URL || "ws://localhost:8080",
    rpcUrl: process.env.AIROTC_PROOF_RPC_URL || process.env.AIR_OTC_RPC_URL || "https://api.devnet.solana.com",
    privateMode: true,
    strictOpaquePerMode: true,
    persistLocalState: false,
  });
}

async function main() {
  const seller = createClient(normalizePrivateKey(requiredEnv("SELLER_PRIVATE_KEY", "AIR_OTC_PROOF_SELLER_KEY")));
  const buyer = createClient(normalizePrivateKey(requiredEnv("BUYER_PRIVATE_KEY", "AIR_OTC_PROOF_BUYER_KEY")));
  const offerReady = deferred();

  const amount = Number(process.env.AIROTC_TRADE_AMOUNT || process.env.AIR_OTC_PROOF_AMOUNT || "1");
  const price = Number(process.env.AIROTC_TRADE_PRICE_SOL || process.env.AIR_OTC_PROOF_PRICE || "0.1");
  const collateral = Number(process.env.AIROTC_TRADE_COLLATERAL_SOL || process.env.AIR_OTC_PROOF_COLLATERAL || "0.02");
  const assetSymbol = process.env.AIROTC_TRADE_ASSET || process.env.AIR_OTC_PROOF_ASSET || "SOL";
  const assetMint = process.env.AIR_OTC_PROOF_ASSET_MINT || WSOL_MINT;
  const deliveryContent =
    process.env.ENCRYPTED_DELIVERY_PAYLOAD ||
    process.env.AIR_OTC_PROOF_DELIVERY ||
    "ACCESS_TOKEN=ACCESS_TOKEN_12345";

  const terms = {
    assetMint,
    assetSymbol,
    priceSol: price,
    buyerCollateralSol: collateral,
    sellerCollateralSol: collateral,
    quantity: amount,
  };

  try {
    const sellerPromise = seller.workflows
      .runSellerFlow({
        mode: "PER",
        offer: {
          asset: assetSymbol,
          mode: "sell",
          amount,
          price,
          collateral,
          rollupMode: "PER",
        },
        terms,
        deliveryContent,
        deliveryLabel: "AIR OTC SDK PER proof delivery",
        matchTimeoutMs: 240_000,
        settlementTimeoutMs: 240_000,
        onOfferCreated: (offer) => {
          console.log(`[SDK-PER-PROOF] seller posted PER offer ${offer.id}`);
          offerReady.resolve(offer.id);
        },
      })
      .then((result) => {
        if (!result.success) throw new Error(`seller PER workflow failed: ${result.error}`);
        return result;
      })
      .catch((error) => {
        offerReady.reject(error);
        throw error;
      });

    const offerId = await withTimeout(offerReady.promise, 120_000, "Waiting for seller PER offer");
    const buyerResult = await buyer.workflows.runBuyerFlow({
      mode: "PER",
      offerId,
      terms,
      fundingTimeoutMs: 180_000,
      deliveryTimeoutMs: 180_000,
      settlementTimeoutMs: 240_000,
    });
    const sellerResult = await sellerPromise;

    if (!buyerResult.success) throw new Error(`buyer PER workflow failed: ${buyerResult.error}`);

    console.log(
      `[SDK-PER-PROOF] completed PER workflow buyerTicket=${buyerResult.deal?.id ?? "unknown"} sellerTicket=${sellerResult.deal?.id ?? "unknown"}`
    );
  } finally {
    seller.disconnect();
    buyer.disconnect();
  }
}

await main();
