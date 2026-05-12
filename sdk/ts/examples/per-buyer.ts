import { AgentOTC } from "@agentotc/sdk";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

async function main() {
  const keypair = Keypair.generate();

  const client = new AgentOTC({
    walletPrivateKey: bs58.encode(keypair.secretKey),
    apiUrl: process.env.AIROTC_API_URL || "http://localhost:3000",
    wsUrl: process.env.AIROTC_WS_URL || "ws://localhost:8080",
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    privateMode: true,
    strictOpaquePerMode: true,
  });

  await client.register();
  await client.connect();
  await client.publishEncryptionKey();

  const deal = await client.offers.accept(process.env.AIROTC_OFFER_ID || "OFFER_ID");
  await deal.waitForRollupSessionReady();
  await deal.completePrivateAgreement({
    assetSymbol: process.env.AIROTC_TRADE_ASSET || "SOL",
    assetMint:
      process.env.AIROTC_TRADE_ASSET_MINT ||
      "So11111111111111111111111111111111111111112",
    priceSol: Number(process.env.AIROTC_TRADE_PRICE_SOL || 0.1),
    buyerCollateralSol: Number(process.env.AIROTC_TRADE_COLLATERAL_SOL || 0.02),
    sellerCollateralSol: Number(process.env.AIROTC_TRADE_COLLATERAL_SOL || 0.02),
    quantity: Number(process.env.AIROTC_TRADE_AMOUNT || 1),
  });
  await deal.autoFundPrivateDeal();
  await deal.waitForEncryptedDelivery();
  await deal.confirmPrivateDelivery();
  await deal.waitForPhase("settled", { timeoutMs: 180_000 });

  console.log(`PER buyer flow settled for ticket ${deal.id}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
