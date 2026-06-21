const DEFAULT_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const MIN_DEVNET_PROOF_TIMEOUT_SECONDS = 10;

export type NormalEscrowTimeoutPolicy = {
  durationSeconds: number;
  timeoutUnixSeconds: number;
  timeoutDate: Date;
  source: "default_7_day_timeout" | "devnet_proof_override";
  devnetOnly: boolean;
};

function parsePositiveInteger(value: string, envName: string): number {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${envName}_must_be_integer_seconds`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName}_must_be_positive_safe_integer_seconds`);
  }
  return parsed;
}

function hasDevnetSignal(env: NodeJS.ProcessEnv): boolean {
  const keys = [
    "SOLANA_CLUSTER",
    "AIR_OTC_CLUSTER",
    "AIR_OTC_ENVIRONMENT",
    "SOLANA_RPC_URL",
    "AIR_OTC_RPC_URL",
    "RPC_URL",
    "ANCHOR_PROVIDER_URL",
  ];
  return keys.some((key) => String(env[key] || "").toLowerCase().includes("devnet"));
}

export function resolveNormalEscrowTimeoutPolicy(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): NormalEscrowTimeoutPolicy {
  const nowSeconds = Math.floor(nowMs / 1000);
  const rawOverride = env.AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS?.trim();

  if (!rawOverride) {
    return {
      durationSeconds: DEFAULT_TIMEOUT_SECONDS,
      timeoutUnixSeconds: nowSeconds + DEFAULT_TIMEOUT_SECONDS,
      timeoutDate: new Date((nowSeconds + DEFAULT_TIMEOUT_SECONDS) * 1000),
      source: "default_7_day_timeout",
      devnetOnly: false,
    };
  }

  const durationSeconds = parsePositiveInteger(
    rawOverride,
    "AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS"
  );
  const proofAck = env.AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF === "true";
  const devnet = hasDevnetSignal(env);

  if (!proofAck || !devnet) {
    throw new Error(
      "short_normal_escrow_timeout_requires_AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF_and_devnet_rpc"
    );
  }
  if (durationSeconds < MIN_DEVNET_PROOF_TIMEOUT_SECONDS) {
    throw new Error(
      `AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS_must_be_at_least_${MIN_DEVNET_PROOF_TIMEOUT_SECONDS}_seconds`
    );
  }
  if (durationSeconds > DEFAULT_TIMEOUT_SECONDS) {
    throw new Error(
      "AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS_must_not_exceed_default_7_day_timeout"
    );
  }

  return {
    durationSeconds,
    timeoutUnixSeconds: nowSeconds + durationSeconds,
    timeoutDate: new Date((nowSeconds + durationSeconds) * 1000),
    source: "devnet_proof_override",
    devnetOnly: true,
  };
}
