import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentOTC } from "../dist/index.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const ZERION_BIN = join(ROOT, "middleman-agent/zerion-core/cli/zerion.js");
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

function walletAddress(raw) {
  return Keypair.fromSecretKey(parseSecretKey(raw)).publicKey.toBase58();
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

function runZerion(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [ZERION_BIN, ...args, "--json"],
      {
        env: process.env,
        timeout: Number(process.env.AIROTC_ZERION_TX_TIMEOUT_MS || 180_000),
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (stdout.trim()) process.stdout.write(`[SDK-ZERION] ${stdout}`);
        if (stderr.trim()) process.stderr.write(`[SDK-ZERION] ${stderr}`);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

async function runZerionGate(role, wallet) {
  if (process.env.AIROTC_REQUIRE_ZERION === "false") return;

  const chain = process.env.AIROTC_ZERION_CHAIN || "solana";
  await runZerion([
    "airotc",
    "policy-check",
    "--wallet",
    wallet,
    "--role",
    role,
    "--chain",
    chain,
    "--max-spend-usd",
    process.env.AIROTC_ZERION_MAX_SPEND_USD || "1",
    "--actions",
    process.env.AIROTC_ZERION_ACTIONS || "verify,swap",
  ]);

  const offline = process.env.AIROTC_ZERION_ALLOW_OFFLINE === "true" ? ["--allow-offline"] : [];
  if (role === "seller") {
    await runZerion([
      "airotc",
      "verify-seller",
      "--wallet",
      wallet,
      "--asset",
      process.env.AIROTC_ZERION_ASSET || process.env.AIROTC_TRADE_ASSET || "SOL",
      "--min-amount",
      process.env.AIROTC_TRADE_AMOUNT || "1",
      "--chain",
      chain,
      ...offline,
    ]);
    return;
  }

  await runZerion([
    "airotc",
    "verify-buyer",
    "--wallet",
    wallet,
    "--min-value-usd",
    process.env.AIROTC_ZERION_BUYER_MIN_VALUE_USD || "1",
    "--chain",
    chain,
    ...offline,
  ]);
}

async function runZerionTxGate() {
  if (process.env.AIROTC_REQUIRE_ZERION === "false") return;
  if (process.env.AIROTC_ZERION_ALLOW_OFFLINE === "true") {
    console.log("[SDK-FULL-PIPELINE] Zerion offline mode is enabled for local tests only");
    return;
  }
  if (process.env.AIROTC_ZERION_EXTERNAL_TX) {
    await runZerion([
      "airotc",
      "execute-demo-tx",
      "--external-tx",
      process.env.AIROTC_ZERION_EXTERNAL_TX,
    ]);
    return;
  }
  if (process.env.AIROTC_ZERION_EXECUTE_REAL_TX === "true") {
    await runZerion([
      "airotc",
      "execute-demo-tx",
      "--execute",
      process.env.AIROTC_ZERION_FROM_TOKEN || "SOL",
      process.env.AIROTC_ZERION_TO_TOKEN || "USDC",
      process.env.AIROTC_ZERION_TX_AMOUNT || "0.0001",
      "--chain",
      process.env.AIROTC_ZERION_CHAIN || "solana",
    ]);
    return;
  }
  throw new Error(
    "SDK full-pipeline proof requires AIROTC_ZERION_EXTERNAL_TX or AIROTC_ZERION_EXECUTE_REAL_TX=true"
  );
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
  process.env.AIROTC_REQUIRE_FULL_UMBRA ||= "true";
  process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE ||= "FULL_UMBRA";
  process.env.AIROTC_REQUIRE_ZERION ||= "true";

  const sellerKey = requiredEnv("SELLER_PRIVATE_KEY", "AIR_OTC_PROOF_SELLER_KEY");
  const buyerKey = requiredEnv("BUYER_PRIVATE_KEY", "AIR_OTC_PROOF_BUYER_KEY");
  const sellerWallet = walletAddress(sellerKey);
  const buyerWallet = walletAddress(buyerKey);
  const seller = createClient(normalizePrivateKey(sellerKey));
  const buyer = createClient(normalizePrivateKey(buyerKey));
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
    await runZerionTxGate();
    await Promise.all([
      runZerionGate("seller", sellerWallet),
      runZerionGate("buyer", buyerWallet),
    ]);

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
        deliveryLabel: "AIR OTC SDK full-pipeline proof delivery",
        matchTimeoutMs: 240_000,
        settlementTimeoutMs: 240_000,
        umbraLifecycleTimeoutMs: 300_000,
        requireFullUmbraLifecycle: true,
        onOfferCreated: (offer) => {
          console.log(`[SDK-FULL-PIPELINE] seller posted PER offer ${offer.id}`);
          offerReady.resolve(offer.id);
        },
      })
      .then((result) => {
        if (!result.success) throw new Error(`seller full-pipeline workflow failed: ${result.error}`);
        if (!result.umbraLifecycle) throw new Error("seller did not complete full Umbra lifecycle");
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
      umbraLifecycleTimeoutMs: 300_000,
      requireFullUmbraLifecycle: true,
    });
    const sellerResult = await sellerPromise;

    if (!buyerResult.success) throw new Error(`buyer full-pipeline workflow failed: ${buyerResult.error}`);
    if (!buyerResult.umbraLifecycle) throw new Error("buyer did not complete full Umbra lifecycle");

    console.log(
      `[SDK-FULL-PIPELINE] completed Zerion-gated PER + full Umbra workflow buyerTicket=${buyerResult.deal?.id ?? "unknown"} sellerTicket=${sellerResult.deal?.id ?? "unknown"}`
    );
  } finally {
    seller.disconnect();
    buyer.disconnect();
  }
}

await main();
