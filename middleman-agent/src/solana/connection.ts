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

export async function createVerifiedConnection(
  rpcUrl?: string,
  commitment: Commitment = "confirmed"
): Promise<{
  connection: Connection;
  slot: number;
  blockHeight: number;
}> {
  const maxAttempts = Math.max(1, rpcManager.getEndpointCount());
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const rpcIndex = rpcManager.getCurrentIndex();
    const connection = createConnection(rpcUrl, commitment);

    try {
      const verified = await verifyConnection(connection);
      if (attempt > 0) {
        logger.info("solana_connection_startup_failover_verified", {
          rpc_index: rpcManager.getCurrentIndex(),
          attempt: attempt + 1,
        });
      }
      return { connection, ...verified };
    } catch (error) {
      lastError = error;
      logger.warn(
        "solana_connection_startup_failover_attempt_failed",
        {
          rpc_index: rpcIndex,
          attempt: attempt + 1,
          max_attempts: maxAttempts,
        },
        error
      );

      rpcManager.markFailure(rpcIndex);
      if (attempt < maxAttempts - 1) {
        rpcManager.switchEndpoint();
      }
    }
  }

  logger.error("solana_connection_startup_failover_exhausted", {
    max_attempts: maxAttempts,
  }, lastError);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
