import { Connection, Commitment } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { rpcManager } from "../utils/rpcManager";
import { redactUrlSecret } from "../utils/redact";

export function createConnection(
  rpcUrl?: string,
  commitment: Commitment = "confirmed"
): Connection {
  const conn = rpcManager.getConnection(commitment);
  logger.info("solana_connection_created", {
    rpcUrl: redactUrlSecret(rpcManager.getCurrentEndpoint()),
    commitment,
  });
  return conn;
}

export function getConnection(): Connection {
  return rpcManager.getConnection();
}

export async function verifyConnection(conn: Connection): Promise<{
  slot: number;
  blockHeight: number;
}> {
  try {
    const slot = await conn.getSlot();
    const blockHeight = await conn.getBlockHeight();

    logger.info("solana_connection_verified", { slot, blockHeight });

    return { slot, blockHeight };
  } catch (error) {
    logger.error("solana_connection_verify_failed", {}, error);
    throw error;
  }
}
