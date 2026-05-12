import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../utils/logger";

let agentKeypair: Keypair | null = null;

export function loadWallet(privateKeyBase58: string): Keypair {
  if (agentKeypair) {
    return agentKeypair;
  }

  try {
    const secretKey = bs58.decode(privateKeyBase58);
    agentKeypair = Keypair.fromSecretKey(secretKey);

    logger.info("wallet_loaded", {
      publicKey: agentKeypair.publicKey.toBase58(),
    });

    return agentKeypair;
  } catch (error) {
    logger.error("wallet_load_failed", {}, error);
    throw new Error(
      "Failed to load wallet. Ensure PRIVATE_KEY is a valid base58-encoded secret key."
    );
  }
}

export function getWallet(): Keypair {
  if (!agentKeypair) {
    throw new Error("Wallet not initialized. Call loadWallet() first.");
  }
  return agentKeypair;
}

export function getPublicKey(): PublicKey {
  return getWallet().publicKey;
}

export async function getWalletBalance(
  connection: Connection
): Promise<number> {
  try {
    const balance = await connection.getBalance(getPublicKey());
    const solBalance = balance / LAMPORTS_PER_SOL;

    logger.info("wallet_balance_fetched", {
      publicKey: getPublicKey().toBase58(),
      lamports: balance,
      sol: solBalance,
    });

    return solBalance;
  } catch (error) {
    logger.error("wallet_balance_fetch_failed", {}, error);
    throw error;
  }
}
