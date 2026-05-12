import { createHash } from "crypto";
import dotenv from "dotenv";
import path from "path";
import { loadConfig } from "../../src/config";
import {
  TORQUE_EVENT_NAME,
  TORQUE_SCHEMA_VERSION,
  bigintToSafeNumber,
  calculateTorqueParticipantReward,
  solToLamports,
} from "../../src/services/torqueRewardPolicy";

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

interface TorqueSmokePayload {
  userPubkey: string;
  timestamp: number;
  eventName: typeof TORQUE_EVENT_NAME;
  data: {
    tradeRef: string;
    participantRole: "buyer" | "seller";
    rollupMode: "ER" | "PER";
    settlementPolicy: "DIRECT" | "STEALTH";
    pipelineRoute: "STANDARD_ESCROW" | "CONFIDENTIAL_ESCROW";
    tradeNotionalLamports: number;
    platformFeeBps: number;
    platformFeeLamports: number;
    participantRewardLamports: number;
    schemaVersion: number;
  };
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const apiKey = requireEnv("TORQUE_EVENT_API_KEY");
  const userPubkey = requireEnv("TORQUE_SMOKE_USER_PUBKEY");
  const ingestUrl = (process.env.TORQUE_INGEST_URL || "https://ingest.torque.so/events").trim();
  const ticketSeed = process.env.TORQUE_SMOKE_TICKET_SEED?.trim() || `torque-smoke-${Date.now()}`;
  const participantRole =
    process.env.TORQUE_SMOKE_PARTICIPANT_ROLE?.trim() === "seller" ? "seller" : "buyer";
  const rollupMode =
    process.env.TORQUE_SMOKE_ROLLUP_MODE?.trim() === "ER" ? "ER" : "PER";
  const settlementPolicy =
    process.env.TORQUE_SMOKE_SETTLEMENT_POLICY?.trim() === "DIRECT" ? "DIRECT" : "STEALTH";
  const pipelineRoute =
    process.env.TORQUE_SMOKE_PIPELINE_ROUTE?.trim() === "STANDARD_ESCROW"
      ? "STANDARD_ESCROW"
      : "CONFIDENTIAL_ESCROW";
  const tradePriceSol = Number(process.env.TORQUE_SMOKE_PRICE_SOL?.trim() || "10");
  const rewardQuote = calculateTorqueParticipantReward({
    rollupMode,
    tradeNotionalLamports: solToLamports(tradePriceSol),
    config: loadConfig(),
  });

  const payload: TorqueSmokePayload = {
    userPubkey,
    timestamp: Date.now(),
    eventName: TORQUE_EVENT_NAME,
    data: {
      tradeRef: sha256Hex(ticketSeed),
      participantRole,
      rollupMode,
      settlementPolicy,
      pipelineRoute,
      tradeNotionalLamports: bigintToSafeNumber(
        rewardQuote.tradeNotionalLamports,
        "trade_notional_lamports"
      ),
      platformFeeBps: rewardQuote.platformFeeBps,
      platformFeeLamports: bigintToSafeNumber(
        rewardQuote.platformFeeLamports,
        "platform_fee_lamports"
      ),
      participantRewardLamports: bigintToSafeNumber(
        rewardQuote.participantRewardLamports,
        "participant_reward_lamports"
      ),
      schemaVersion: TORQUE_SCHEMA_VERSION,
    },
  };

  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Torque smoke emit failed (${response.status}): ${body}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        ingestUrl,
        eventName: payload.eventName,
        userPubkey: payload.userPubkey,
        tradeRef: payload.data.tradeRef,
        responseBody: body || null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
