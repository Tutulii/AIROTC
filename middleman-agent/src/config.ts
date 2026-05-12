import dotenv from "dotenv";
import path from "path";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export interface AgentEvent {
  type: string;
  timestamp: Date;
  detail?: string;
  severity?: string;
}

export interface AgentConfig {
  solanaRpcUrl: string;
  programId: string;
  privateKey: string;
  heartbeatIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  network: string;
  openaiApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  enableNoiseSimulation: boolean;
  treasuryMinBalanceSol: number;
  treasuryTargetBalanceSol: number;
  treasuryAutoFundEnabled: boolean;
  jupiterApiUrl: string;
  zerionApiKey?: string;
  zerionApiBaseUrl: string;
  zerionVerificationMode: "hybrid" | "strict" | "rpc_only";
  agentEndpoint: string;
  enableSoulEngine: boolean;
  enableSocialVoice: boolean;
  soulFilePath: string;
  cognitiveIntervalMs: number;
  enableCognitiveLoop: boolean;
  cognitiveMemoryDepth: number;
  cognitiveEventDepth: number;
  socialPostAnnoyanceThreshold: number;
  // Model split: different models for different decision domains
  llmModelFast: string;      // for trade analysis (middlemanBrain)
  llmModelDeep: string;      // for philosophy/soul (curiosityEngine, cognitiveEngine)
  llmModelJudge: string;     // for disputes (aiJudge)
  // Track 6: Encrypt (FHE) + Ika (dWallet)
  encryptProgramId: string;
  encryptGrpcUrl: string;
  confidentialEscrowProgramId: string;
  dwalletProgramId: string;
  ikaGrpcUrl: string;
  enableConfidentialEscrow: boolean;
  dwalletCurve: number;        // 0=Secp256k1, 1=Secp256r1, 2=Curve25519, 3=Ristretto
  dwalletSignatureScheme: number; // 0=EcdsaKeccak256..5=EddsaSha512..6=SchnorrkelMerlin
  ikaGasDepositMode: "detect_only" | "create" | "require_create";
  releaseDisputeWindowSeconds: number;
  perStrictOpaqueMode: boolean;
  perFundingPrivacyTier: "DIRECT_SOL" | "STEALTH_SOL" | "SHIELDED_CREDIT";
  perAllowDirectSolUnsafe: boolean;
  umbraSettlementLifecycleMode: "RECEIVER_WALLET_ONLY" | "FULL_UMBRA";
  requireFullUmbraLifecycle: boolean;
  enableLegacyUmbraStealthLifecycle: boolean;
  enableTorqueEvents: boolean;
  torqueIngestUrl: string;
  torqueEventApiKey?: string;
  torqueRequestTimeoutMs: number;
  torqueRetryBaseMs: number;
  torqueRetryMaxMs: number;
  torqueRetryPollMs: number;
  erPlatformFeeBps: number;
  perPlatformFeeBps: number;
  erRewardShareOfFeeBps: number;
  perRewardShareOfFeeBps: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function parseBps(key: string, fallback: string): number {
  const raw = optionalEnv(key, fallback);
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${key} must be an integer between 0 and 10000`);
  }
  return parsed;
}

export function loadConfig(): AgentConfig {
  const rpcUrl = optionalEnv(
    "SOLANA_RPC_URL",
    "https://api.devnet.solana.com"
  );

  // Derive network name from RPC URL
  let network = "unknown";
  if (rpcUrl.includes("devnet")) network = "devnet";
  else if (rpcUrl.includes("mainnet")) network = "mainnet-beta";
  else if (rpcUrl.includes("testnet")) network = "testnet";
  else if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1"))
    network = "localnet";

  const config: AgentConfig = {
    solanaRpcUrl: rpcUrl,
    programId: requireEnv("PROGRAM_ID"),
    privateKey: requireEnv("PRIVATE_KEY"),
    heartbeatIntervalMs: parseInt(
      optionalEnv("HEARTBEAT_INTERVAL_MS", "5000"),
      10
    ),
    logLevel: optionalEnv("LOG_LEVEL", "info") as AgentConfig["logLevel"],
    network,
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    llmBaseUrl: optionalEnv("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    llmModel: optionalEnv("LLM_MODEL", "openai/gpt-oss-120b"),
    enableNoiseSimulation: optionalEnv("ENABLE_NOISE_SIMULATION", "false").toLowerCase() === "true",
    treasuryMinBalanceSol: parseFloat(optionalEnv("TREASURY_MIN_BALANCE_SOL", "1.0")),
    treasuryTargetBalanceSol: parseFloat(optionalEnv("TREASURY_TARGET_BALANCE_SOL", "5.0")),
    treasuryAutoFundEnabled: optionalEnv("TREASURY_AUTO_FUND_ENABLED", "true").toLowerCase() === "true",
    jupiterApiUrl: optionalEnv("JUPITER_API_URL", "https://quote-api.jup.ag/v6"),
    zerionApiKey: process.env.ZERION_API_KEY?.trim() || undefined,
    zerionApiBaseUrl: optionalEnv("ZERION_API_BASE_URL", "https://api.zerion.io/v1"),
    zerionVerificationMode: optionalEnv(
      "ZERION_VERIFICATION_MODE",
      network === "mainnet-beta" ? "strict" : "hybrid"
    ) as AgentConfig["zerionVerificationMode"],
    agentEndpoint: optionalEnv("AGENT_ENDPOINT", "ws://localhost:8080"),
    enableSoulEngine: optionalEnv("ENABLE_SOUL_ENGINE", "true").toLowerCase() === "true",
    enableSocialVoice: optionalEnv("ENABLE_SOCIAL_VOICE", "false").toLowerCase() === "true",
    soulFilePath: optionalEnv("SOUL_FILE_PATH", path.resolve(__dirname, "..", "SOUL.md")),
    cognitiveIntervalMs: parseInt(optionalEnv("COGNITIVE_INTERVAL_MS", "60000"), 10),
    enableCognitiveLoop: optionalEnv("ENABLE_COGNITIVE_LOOP", "true").toLowerCase() === "true",
    cognitiveMemoryDepth: parseInt(optionalEnv("COGNITIVE_MEMORY_DEPTH", "5"), 10),
    cognitiveEventDepth: parseInt(optionalEnv("COGNITIVE_EVENT_DEPTH", "10"), 10),
    socialPostAnnoyanceThreshold: parseInt(optionalEnv("SOCIAL_POST_ANNOYANCE_THRESHOLD", "7"), 10),
    // Model split: each defaults to the primary llmModel if not specified
    llmModelFast: optionalEnv("LLM_MODEL_FAST", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
    llmModelDeep: optionalEnv("LLM_MODEL_DEEP", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
    llmModelJudge: optionalEnv("LLM_MODEL_JUDGE", optionalEnv("LLM_MODEL", "openai/gpt-oss-120b")),
    // Track 6: Encrypt (FHE) + Ika (dWallet)
    encryptProgramId: optionalEnv("ENCRYPT_PROGRAM_ID", "ENcR3kPU6MNM1VTH2LxYdGM2UR2FjisKSbJWhHsuPMz"),
    encryptGrpcUrl: optionalEnv("ENCRYPT_GRPC_URL", "https://pre-alpha-dev-1.encrypt.ika-network.net:443"),
    confidentialEscrowProgramId: optionalEnv("CONFIDENTIAL_ESCROW_PROGRAM_ID", "BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj"),
    dwalletProgramId: optionalEnv("DWALLET_PROGRAM_ID", "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY"),
    ikaGrpcUrl: optionalEnv("IKA_GRPC_URL", "pre-alpha-dev-1.ika.ika-network.net:443"),
    enableConfidentialEscrow: optionalEnv("ENABLE_CONFIDENTIAL_ESCROW", "false").toLowerCase() === "true",
    dwalletCurve: parseInt(optionalEnv("DWALLET_CURVE", "2"), 10),
    dwalletSignatureScheme: parseInt(optionalEnv("DWALLET_SIGNATURE_SCHEME", "5"), 10),
    ikaGasDepositMode: optionalEnv("IKA_GAS_DEPOSIT_MODE", "detect_only") as AgentConfig["ikaGasDepositMode"],
    releaseDisputeWindowSeconds: parseInt(
      optionalEnv("RELEASE_DISPUTE_WINDOW_SECONDS", network === "mainnet-beta" ? "300" : "15"),
      10
    ),
    perStrictOpaqueMode:
      optionalEnv("PER_STRICT_OPAQUE_MODE", "true").toLowerCase() === "true",
    perFundingPrivacyTier: optionalEnv(
      "PER_FUNDING_PRIVACY_TIER",
      "SHIELDED_CREDIT"
    ) as AgentConfig["perFundingPrivacyTier"],
    perAllowDirectSolUnsafe:
      optionalEnv("PER_ALLOW_DIRECT_SOL_UNSAFE", "false").toLowerCase() === "true",
    umbraSettlementLifecycleMode: optionalEnv(
      "UMBRA_SETTLEMENT_LIFECYCLE_MODE",
      "FULL_UMBRA"
    ) as AgentConfig["umbraSettlementLifecycleMode"],
    requireFullUmbraLifecycle:
      optionalEnv("AIROTC_REQUIRE_FULL_UMBRA", "true").toLowerCase() === "true",
    enableLegacyUmbraStealthLifecycle:
      optionalEnv("ENABLE_LEGACY_UMBRA_STEALTH_LIFECYCLE", "false").toLowerCase() === "true",
    enableTorqueEvents:
      optionalEnv("ENABLE_TORQUE_EVENTS", "false").toLowerCase() === "true",
    torqueIngestUrl: optionalEnv("TORQUE_INGEST_URL", "https://ingest.torque.so/events"),
    torqueEventApiKey: process.env.TORQUE_EVENT_API_KEY?.trim() || undefined,
    torqueRequestTimeoutMs: parseInt(optionalEnv("TORQUE_REQUEST_TIMEOUT_MS", "8000"), 10),
    torqueRetryBaseMs: parseInt(optionalEnv("TORQUE_RETRY_BASE_MS", "5000"), 10),
    torqueRetryMaxMs: parseInt(optionalEnv("TORQUE_RETRY_MAX_MS", "60000"), 10),
    torqueRetryPollMs: parseInt(optionalEnv("TORQUE_RETRY_POLL_MS", "10000"), 10),
    erPlatformFeeBps: parseBps("ER_PLATFORM_FEE_BPS", "100"),
    perPlatformFeeBps: parseBps("PER_PLATFORM_FEE_BPS", "110"),
    erRewardShareOfFeeBps: parseBps("ER_REWARD_SHARE_OF_FEE_BPS", "1000"),
    perRewardShareOfFeeBps: parseBps("PER_REWARD_SHARE_OF_FEE_BPS", "1200"),
  };

  if (!["DIRECT_SOL", "STEALTH_SOL", "SHIELDED_CREDIT"].includes(config.perFundingPrivacyTier)) {
    throw new Error("PER_FUNDING_PRIVACY_TIER must be DIRECT_SOL, STEALTH_SOL, or SHIELDED_CREDIT");
  }
  if (!["RECEIVER_WALLET_ONLY", "FULL_UMBRA"].includes(config.umbraSettlementLifecycleMode)) {
    throw new Error("UMBRA_SETTLEMENT_LIFECYCLE_MODE must be RECEIVER_WALLET_ONLY or FULL_UMBRA");
  }
  if (
    config.perStrictOpaqueMode &&
    config.perFundingPrivacyTier === "DIRECT_SOL" &&
    !config.perAllowDirectSolUnsafe
  ) {
    throw new Error(
      "Strict PER cannot use DIRECT_SOL funding unless PER_ALLOW_DIRECT_SOL_UNSAFE=true"
    );
  }

  return config;
}
