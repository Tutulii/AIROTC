import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export const TORQUE_EVENT_NAME = "air_otc_trade_reward_participant_v2";
export const TORQUE_SCHEMA_VERSION = 2;
const BPS_DENOMINATOR = 10_000n;

export type TorqueRewardRollupMode = "ER" | "PER";

export interface TorqueRewardPolicyConfig {
  erPlatformFeeBps: number;
  perPlatformFeeBps: number;
  erRewardShareOfFeeBps: number;
  perRewardShareOfFeeBps: number;
}

export interface TorqueRewardQuote {
  tradeNotionalLamports: bigint;
  platformFeeBps: number;
  platformFeeLamports: bigint;
  participantRewardLamports: bigint;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function assertPositiveLamports(lamports: bigint): void {
  if (lamports <= 0n) {
    throw new Error("torque_reward_trade_notional_must_be_positive");
  }
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error(`invalid_trade_notional_sol:${sol}`);
  }
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function bigintToSafeNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`torque_reward_${label}_exceeds_safe_integer`);
  }
  return asNumber;
}

export function calculateTorqueParticipantReward(input: {
  rollupMode: TorqueRewardRollupMode;
  tradeNotionalLamports: bigint;
  config: TorqueRewardPolicyConfig;
}): TorqueRewardQuote {
  assertPositiveLamports(input.tradeNotionalLamports);

  const isPer = input.rollupMode === "PER";
  const platformFeeBps = isPer
    ? input.config.perPlatformFeeBps
    : input.config.erPlatformFeeBps;
  const rewardShareOfFeeBps = isPer
    ? input.config.perRewardShareOfFeeBps
    : input.config.erRewardShareOfFeeBps;

  const platformFeeLamports = roundDiv(
    input.tradeNotionalLamports * BigInt(platformFeeBps),
    BPS_DENOMINATOR
  );
  const rewardPoolLamports = roundDiv(
    platformFeeLamports * BigInt(rewardShareOfFeeBps),
    BPS_DENOMINATOR
  );
  const participantRewardLamports = rewardPoolLamports / 2n;

  return {
    tradeNotionalLamports: input.tradeNotionalLamports,
    platformFeeBps,
    platformFeeLamports,
    participantRewardLamports,
  };
}
