import { loadConfig, AgentConfig } from "./config";
import { logger } from "./utils/logger";
import { createVerifiedConnection, getConnection } from "./solana/connection";
import { loadWallet, getWalletBalance } from "./solana/wallet";
import { loadProgram, deriveConfigPda } from "./solana/program";
import { eventBus } from "./services/eventBus";
import { startOfferListener, stopOfferListener } from "./listeners/offerListener";
import { startAcceptanceListener, stopAcceptanceListener } from "./listeners/acceptanceListener";
import { initAgentMessageListener } from "./listeners/agentMessageListener";
import { parseMessage } from "./services/parserService";
import { negotiationStore } from "./state/negotiationStore";
import { executeDeal, executeRelease } from "./services/executionService";
import { executeCancelDeal, executeSettleToBuyerPhase } from "./services/onChainExecutionService";
import { initEscrowListener } from "./listeners/escrowListener";
import { initRollupListener } from "./listeners/rollupListener";
import { ticketStore } from "./state/ticketStore";
import { walletRegistry } from "./state/walletRegistry";
import { vectorMemoryStore } from "./state/vectorMemoryStore";
import { dealTracker } from "./state/dealTracker";
import { analyzeMessage, NegotiationSignals } from "../core/middlemanBrain";
import { dealPhaseManager } from "../core/dealPhaseManager";
import { reconcileDepositWatcherFromHistory, watchForDeposits } from "./listeners/depositWatcher";
import { startIntentListener, stopIntentListener } from "./listeners/intentListener";
import { executeConfirmDeposit, getDealContext, executeFractionalSplit } from "./services/onChainExecutionService";
import { startDealTimeoutWatcher, stopDealTimeoutWatcher } from "./services/dealTimeoutWatcher";
import { startWsGateway, stopWsGateway } from "./gateway/wsServer";
import { initOutboundRouter, stopOutboxProcessor } from "./services/outboundRouter";
import { recoverInFlightDeals } from "./services/contextRecovery";
import {
  recoverPendingDealPipelines,
  recoverPendingPrivateSessionFinalizations,
} from "./services/pipelineRecoveryService";

import { shutdownManager } from "./utils/shutdownManager";
import { prisma } from "./lib/prisma";
import { ensureTorqueSchema } from "./lib/ensureTorqueSchema";
import { startHealthServer, stopHealthServer } from "./api/health";
import { startRestApi, stopRestApi } from "./api/restServer";
import { treasuryTick } from "./services/treasuryManager";
import { logDecision, markDealOutcome, runThresholdTuning } from "../core/strategyLearner";
import { pruneStaleEntries as pruneHealerCache } from "../core/autoHealerMemory";
import { startMarketDiscovery, stopMarketDiscovery } from "./services/marketDiscovery";
import { startPriceOracle, stopPriceOracle } from "./services/priceOracle";
import { performanceAnalysisTick } from "../core/performanceAnalyzer";
import { enforceLiveness } from "./services/livenessEnforcer";
import { pollDepositsForActiveDeal } from "./services/depositPollingFallback";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assertDealWithinLifetime } from "./services/onChainExecutionService";
import { watchdogTick } from "./services/watchdog";
import { soulEngine } from "./services/soulEngine";
import { CognitiveEngine } from "./services/cognitiveEngine";
import { initSpontaneousPostListener } from "./services/socialVoice";
import { curiosityEngine } from "./services/curiosityEngine";
import { experienceMemory } from "./services/experienceMemory";
import { startMatchingEngine, matchingTick } from "./services/matchingEngine";
import { startSubconsciousLoop, stopSubconsciousLoop } from "./services/subconsciousLoop";
import { initObservatoryBridge } from "./services/observatoryBridge";
import { startPatternDetector, stopPatternDetector, getDetectedHabitsPrompt } from "./services/patternDetector";
import { runDecayCycle } from "./services/decaySystem";
import { startInnerMonologueLoop, stopInnerMonologueLoop } from "./services/innerMonologueLoop";
import { magicBlockSessions } from "./services/magicBlockSessionManager";
import { initTorqueEventService, stopTorqueEventService } from "./services/torqueEventService";
import { pipelineStateStore } from "./state/pipelineStateStore";
import { shouldSkipNegotiationBrainAnalysis } from "./services/negotiationBrainGuard";
import { redactUrlSecret } from "./utils/redact";
import { demoRuntimeListenersAllowed } from "./utils/demoMode";
import { classifyDependencyError } from "./services/dependencyHealthService";
import { isRetryableError } from "./utils/retry";
import type { DepositReceivedEvent } from "./types/events";
import { resolveEscrowTermsForTicket } from "./services/escrowTermsResolver";

// ── Graceful shutdown ────────────────────────────────────────────────

let isShuttingDown = false;
const depositConfirmationQueues = new Map<string, Promise<void>>();

function shouldKeepRunningAfterUnhandled(reason: unknown): boolean {
  if (process.env.EXIT_ON_UNHANDLED_REJECTION === "true") {
    return false;
  }
  const dependency = classifyDependencyError(reason);
  return isRetryableError(reason) && dependency !== "unknown";
}

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Phase 1: Signal intention
    shutdownManager.beginShutdown();

    logger.info("agent_shutdown_initiated", { signal });

    // Phase 2: Snap core intake listeners closed. Loop breaks trigger internally.
    stopHealthServer(); // Shut off Observability Node pings
    stopWsGateway(); // Stop edge websocket connections from bypassing
    stopRestApi(); // Stop edge REST ingress
    stopOfferListener();
    stopAcceptanceListener();
    stopDealTimeoutWatcher();
    stopOutboxProcessor();
    stopMarketDiscovery();
    stopPriceOracle();
    stopIntentListener();
    stopSubconsciousLoop();
    stopPatternDetector();
    stopInnerMonologueLoop();
    stopTorqueEventService();

    // Phase 3: Wait for Execution Layer to finalize any Inflights safely.
    try {
      await shutdownManager.waitForDrain({ timeoutMs: 30000 });
    } catch (e) {
      logger.error("shutdown_drain_error", {}, e);
    }

    // Phase 4: Lock database connections tightly
    await prisma.$disconnect();

    logger.info("shutdown_complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", {}, error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const dependency = classifyDependencyError(reason);
    logger.error("unhandled_rejection", { dependency }, reason);
    if (shouldKeepRunningAfterUnhandled(reason)) {
      logger.warn("transient_unhandled_rejection_suppressed", {
        dependency,
        policy: "keep_runtime_alive_for_retryable_external_dependency",
      });
      return;
    }
    process.exit(1);
  });
}

// ── Heartbeat loop ───────────────────────────────────────────────────

async function heartbeatLoop(
  config: AgentConfig,
  tickCount: { value: number }
): Promise<never> {
  while (!isShuttingDown) {
    await new Promise((resolve) =>
      setTimeout(resolve, config.heartbeatIntervalMs)
    );

    tickCount.value++;

    // Treasury autonomous balance check (runs every Nth tick internally)
    treasuryTick(tickCount.value).catch((e) =>
      logger.error("treasury_tick_unhandled", {}, e)
    );

    // Performance analyzer & strategy tuning (runs every 100th tick internally)
    performanceAnalysisTick(tickCount.value).catch((e) =>
      logger.error("performance_tick_unhandled", {}, e)
    );

    // LEVEL 5: Liveness enforcer — detect stuck deals every 20th tick (~60s)
    if (tickCount.value % 20 === 0) {
      enforceLiveness().catch((e) =>
        logger.error("liveness_tick_unhandled", {}, e)
      );
      watchdogTick().catch((e) =>
        logger.error("watchdog_tick_unhandled", {}, e)
      );
    }

    // MATCHING ENGINE: Run every 15th tick (~45s)
    if (tickCount.value % 15 === 0) {
      matchingTick().catch((e) =>
        logger.error("matching_tick_unhandled", {}, e)
      );
    }

    // LEVEL 5: Deposit polling fallback — backup for WS listener every 30th tick (~90s)
    if (tickCount.value % 30 === 0) {
      try {
        const awaitingDeals = dealPhaseManager.listActiveDeals()
          .filter(d => (d.phase === "awaiting_deposits" || d.phase === "escrow_created") && d.escrow_pda && d.terms);
        for (const deal of awaitingDeals) {
          const expectedTotal = Math.floor(
            ((deal.terms!.collateral_buyer || 0) + (deal.terms!.collateral_seller || 0) + (deal.terms!.price || 0)) * LAMPORTS_PER_SOL
          );
          const connection = getConnection();
          if (deal.phase === "escrow_created") {
            const ctx = getDealContext(deal.ticket_id);
            if (ctx) {
              await dealPhaseManager.advanceToAwaitingDeposits(deal.ticket_id);
              await watchForDeposits(
                connection,
                deal.ticket_id,
                ctx.dealPda,
                Math.floor((deal.terms!.collateral_buyer || 0) * LAMPORTS_PER_SOL),
                Math.floor((deal.terms!.collateral_seller || 0) * LAMPORTS_PER_SOL),
                Math.floor((deal.terms!.price || 0) * LAMPORTS_PER_SOL),
              );
            } else {
              logger.warn("deposit_polling_watcher_attach_skipped_no_context", { ticket_id: deal.ticket_id });
            }
          }
          pollDepositsForActiveDeal(
            connection, deal.ticket_id, new PublicKey(deal.escrow_pda!), expectedTotal
          ).then(detected => {
            if (detected) {
              eventBus.publish("deposit_detected_polling", { ticketId: deal.ticket_id });
            }
          }).catch(e => logger.debug("polling_fallback_error", { ticket_id: deal.ticket_id }));
        }
      } catch (e: any) {
        logger.debug("deposit_polling_loop_error", {});
      }
    }

    // DECAY SYSTEM: run once per day (every ~2880 ticks at 3s intervals)
    if (tickCount.value % 2880 === 0 && tickCount.value > 0) {
      runDecayCycle();
    }

    eventBus.publish("agent_alive", {
      tick: tickCount.value,
      uptime_seconds: tickCount.value * (config.heartbeatIntervalMs / 1000),
    });
  }

  // This should never be reached, but satisfies TypeScript
  process.exit(0);
}

// ── Main bootstrap ──────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Setup crash handlers first
  setupShutdownHandlers();

  // 2. Load configuration
  let config: AgentConfig;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("config_load_failed", {}, error);
    process.exit(1);
  }

  logger.info("config_loaded", {
    network: config.network,
    rpcUrl: redactUrlSecret(config.solanaRpcUrl),
    programId: config.programId,
    heartbeatMs: config.heartbeatIntervalMs,
  });

  // Load DB and Sol connection
  await prisma.$connect();
  await ensureTorqueSchema(prisma);
  await createVerifiedConnection(config.solanaRpcUrl);

  // Initialize Soul Engine
  soulEngine.loadSoul();

  // The cognitive engine and legacy prompts have been moved 
  // to the autonomous innerMonologueLoop.

  // 4. Connect to Solana
  const { connection, slot, blockHeight } = await createVerifiedConnection(config.solanaRpcUrl);

  // 5. Load wallet
  const keypair = loadWallet(config.privateKey);
  const balance = await getWalletBalance(connection);

  if (balance < 0.01) {
    logger.warn("low_wallet_balance", {
      sol: balance,
      hint: "Request devnet airdrop: solana airdrop 2 " + keypair.publicKey.toBase58(),
    });
  }

  // 6. Load program
  const { provider, programId } = await loadProgram(
    connection,
    keypair,
    config.programId
  );

  // 7. Derive config PDA for reference
  const [configPda] = deriveConfigPda(programId);

  // 7.5 Recover execution state from database before accepting new work
  await recoverInFlightDeals();

  // 8. Initialize Event Pipeline
  initTorqueEventService();

  eventBus.subscribe("offer_detected", (payload) => {
    logger.info("offer_detected", {
      offer_id: payload.offer_id,
      type: payload.type,
      creator: payload.creator,
    });
  });

  eventBus.subscribe("ticket_created", async (payload) => {
    try {
      const buyerAgent = await walletRegistry.getOrCreateAgent(payload.buyer);
      const sellerAgent = await walletRegistry.getOrCreateAgent(payload.seller);
      payload.buyer = buyerAgent.id;
      payload.seller = sellerAgent.id;
    } catch (e) {
      logger.error("ticket_rejected", { reason: "Invalid agent identity" });
      return;
    }
    if (soulEngine.cognitiveEngine) {
      soulEngine.pushEvent({ type: "ticket_created", timestamp: new Date(), detail: `New deal initiated: ${payload.ticket_id}`, severity: "info" });
    }

    logger.info("ticket_created", {
      ticket_id: payload.ticket_id,
      offer_id: payload.offer_id,
      buyer: payload.buyer,
      seller: payload.seller,
      status: payload.status
    });

    // Initialize deal phase tracking for this ticket
    dealPhaseManager.initDeal(payload.ticket_id, payload.buyer, payload.seller);
    // Initialize the ticket in the store so execution step finds it
    await ticketStore.createTicket({
      ticket_id: payload.ticket_id,
      offer_id: payload.offer_id || "",
      buyer: payload.buyer,
      seller: payload.seller,
      status: payload.status || "active",
      created_at: new Date().toISOString(),
    });
    logger.info("deal_phase_initialized", { ticket_id: payload.ticket_id, phase: "negotiation" });
  });


  eventBus.subscribe("message_received", async (message) => {
    try {
      logger.info("message_received_ENTRY", { ticket_id: message.ticket_id, sender: message.sender, content: message.content?.substring(0, 50) });
      if (!message.sender) {
        logger.error("message_rejected", { reason: "No sender wallet provided" });
        return;
      }

      const rawSender = message.sender;
      let agent;
      try {
        agent = await walletRegistry.getOrCreateAgent(message.sender);
      } catch (e) {
        logger.error("message_rejected", { reason: "Invalid sender identity" });
        return;
      }

      const senderWallet =
        typeof message.senderWallet === "string" && message.senderWallet.trim() !== ""
          ? message.senderWallet
          : agent.wallet || rawSender;

      // overwrite raw wallet with agent uuid
      message.sender = agent.id;

      const ticket = await ticketStore.getTicket(message.ticket_id);
      const strictPerOpaque =
        ticket?.rollup_mode === "PER" && loadConfig().perStrictOpaqueMode;
      if (strictPerOpaque) {
        logger.info("per_strict_chat_observed_without_plaintext_analysis", {
          ticket_id: message.ticket_id,
          sender: message.sender,
        });
        return;
      }

      const latestPipelineStage = await pipelineStateStore.getLatestStage(message.ticket_id);
      if (shouldSkipNegotiationBrainAnalysis(latestPipelineStage)) {
        logger.info("post_negotiation_chat_observed_without_brain_analysis", {
          ticket_id: message.ticket_id,
          sender: message.sender,
          stage: latestPipelineStage?.stage,
          status: latestPipelineStage?.status,
        });
        return;
      }

      // ═══════════════════════════════════════════════════
      // STEP 1: ALWAYS parse negotiation signals (every message)
      // The middleman is always reading and analyzing.
      // ═══════════════════════════════════════════════════
      const history = await negotiationStore.getNegotiationHistory(message.ticket_id) || [];
      const chatHistory = history.map((h: any) => h.rawText);

      const parsed = await parseMessage(message, chatHistory);
      await negotiationStore.addNegotiationStep(message.ticket_id, parsed, message.sender, message.content);

      // ═══════════════════════════════════════════════════
      // VECTOR MEMORY: embed + store (fire-and-forget, never blocks)
      // ═══════════════════════════════════════════════════
      vectorMemoryStore.storeMemory({
        ticketId: message.ticket_id,
        content: message.content,
      }).catch(() => { /* already logged inside storeMemory */ });

      // ═══════════════════════════════════════════════════
      // STEP 2: Build negotiation signals for the brain
      // ═══════════════════════════════════════════════════
      const signals = await negotiationStore.getLatestSignals(message.ticket_id);

      logger.info("negotiation_update", {
        ticket_id: message.ticket_id,
        sender: message.sender,
        price: signals.price || "none",
        collateral_buyer: signals.collateral_buyer || "none",
        collateral_seller: signals.collateral_seller || "none",
        agreement: signals.agreement_score,
      });

      // ═══════════════════════════════════════════════════
      // STEP 3: Feed message to the Middleman Brain
      // The brain decides whether to act based on:
      //   - Auto-agreement detection (price converged + both confirmed)
      //   - @middleman mention with NLP intent analysis
      // ═══════════════════════════════════════════════════
      const decision = await analyzeMessage(
        message.content,
        message.sender,
        message.ticket_id,
        signals
      );

      // If brain says OBSERVE — do nothing, just keep watching
      if (decision.action === "OBSERVE") {
        return;
      }

      // Level 5: Journal every actionable decision for strategy learning
      logDecision(decision).catch(() => { });

      // ═══════════════════════════════════════════════════
      // STEP 4: Brain decided to act — log the decision
      // ═══════════════════════════════════════════════════
      logger.info("brain_decision", {
        ticket_id: message.ticket_id,
        action: decision.action,
        trigger: decision.trigger,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      });

      // Publish command event
      eventBus.publish("command_received", {
        ticket_id: message.ticket_id,
        intent: decision.trigger === "mention" ? "EXECUTE_DEAL" : "NONE",
        action: decision.action,
        sender: senderWallet,
        sender_agent_id: message.sender,
        raw_message: message.content,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        trigger: decision.trigger,
        timestamp: new Date().toISOString(),
      });

      // ═══════════════════════════════════════════════════
      logger.info("brain_inference_trace", {
        ticket_id: message.ticket_id,
        signals,
        decision_action: decision.action,
        decision_reason: decision.reasoning
      });

      if (decision.action === "CREATE_ESCROW") {
        const ticket = await ticketStore.getTicket(message.ticket_id);
        if (ticket?.rollup_mode === "ER" || ticket?.rollup_mode === "PER") {
          logger.warn("rollup_chat_create_escrow_blocked", {
            ticket_id: message.ticket_id,
            rollupMode: ticket.rollup_mode,
            reason: "rollup escrow creation must come from finalized rollup consensus",
          });
          eventBus.publish("middleman_response", {
            ticket_id: message.ticket_id,
            content: "Rollup negotiation is active. Escrow will be created after both agents finalize terms in the rollup session.",
            phase: "rollup_negotiation",
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      if (decision.action === "CREATE_ESCROW" && decision.terms) {
        const ticket = await ticketStore.getTicket(message.ticket_id);
        if (ticket) {
          decision.terms = resolveEscrowTermsForTicket(ticket, decision.terms);
        }
      }

      // STEP 5: Execute the action via dealPhaseManager
      // ═══════════════════════════════════════════════════
      const result = await dealPhaseManager.handleAction(
        decision.action,
        message.ticket_id,
        senderWallet,
        decision.terms || undefined,
        decision.reasoning
      );

      // Publish middleman response
      eventBus.publish("middleman_response", {
        ticket_id: result.response.ticket_id,
        content: result.response.content,
        phase: result.response.phase,
        timestamp: result.response.timestamp,
      });

      // Publish phase change if it happened
      if (result.new_phase) {
        const deal = dealPhaseManager.getDeal(message.ticket_id);
        const lastTransition = deal?.history[deal.history.length - 1];
        if (lastTransition) {
          eventBus.publish("phase_changed", {
            ticket_id: message.ticket_id,
            from_phase: lastTransition.from,
            to_phase: lastTransition.to,
            triggered_by: lastTransition.triggered_by,
            action: lastTransition.action === "AUTO" ? "OBSERVE" : lastTransition.action,
          });
        }
      }

      // If on-chain action needed, trigger execution
      logger.info("on_chain_action_check", {
        ticket_id: message.ticket_id,
        on_chain_action: result.on_chain_action || "NONE",
        phase: result.new_phase || "unchanged",
        success: result.success
      });

      if (result.on_chain_action === "create_deal") {
        logger.info("executeDeal_TRIGGERING", { ticket_id: message.ticket_id });
        executeDeal(message.ticket_id).catch((err: any) => {
          logger.error("execution_unhandled_failure", { ticket_id: message.ticket_id }, err);
        });
      } else if (result.on_chain_action === "release_funds") {
        executeRelease(message.ticket_id).catch((err: any) => {
          logger.error("release_unhandled_failure", { ticket_id: message.ticket_id }, err);
        });
      } else if (result.on_chain_action === "fractional_split_funds") {
        executeFractionalSplit(message.ticket_id, result.splitRatios).catch((err: any) => {
          logger.error("fractional_split_unhandled_failure", { ticket_id: message.ticket_id }, err);
        });
      } else if (result.on_chain_action === "cancel_deal") {
        executeCancelDeal(message.ticket_id).catch((err: any) => {
          logger.error("cancel_unhandled_failure", { ticket_id: message.ticket_id }, err);
        });
      } else if (result.on_chain_action === "settle_to_buyer") {
        executeSettleToBuyerPhase(message.ticket_id).catch((err: any) => {
          logger.error("settle_to_buyer_unhandled_failure", { ticket_id: message.ticket_id }, err);
        });
      }
    } catch (handlerError: any) {
      logger.error("message_received_CRASH", { ticket_id: message.ticket_id, error: handlerError.message, stack: handlerError.stack?.substring(0, 300) });
    }
  });

  eventBus.subscribe("deal_executed", (payload) => {
    logger.info("deal_executed", {
      ticket_id: payload.ticket_id,
      status: payload.status,
    });

    dealPhaseManager
      .syncTerminalPhaseFromExecutionStatus(payload.ticket_id, payload.status)
      .catch((error: any) => {
        logger.error("deal_terminal_phase_sync_failed", {
          ticket_id: payload.ticket_id,
          status: payload.status,
          error: error?.message || String(error),
        });
      });

    if (soulEngine.cognitiveEngine) {
      soulEngine.pushEvent({ type: "deal_executed", timestamp: new Date(), detail: `Deal ${payload.ticket_id} status ${payload.status}`, severity: payload.status === "failed" ? "high" : "low" });
    }

    // Level 5: Mark deal outcome for strategy learning
    if (payload.status === "completed") {
      markDealOutcome(payload.ticket_id, "success").catch(() => { });
    }
  });

  // ── Middleman Intelligence Event Subscribers ──

  eventBus.subscribe("command_received", (payload) => {
    logger.info("brain_action", {
      ticket_id: payload.ticket_id,
      action: payload.action,
      trigger: payload.trigger,
      confidence: payload.confidence,
      sender: payload.sender,
    });
  });

  eventBus.subscribe("phase_changed", (payload) => {
    logger.info("phase_changed", {
      ticket_id: payload.ticket_id,
      from: payload.from_phase,
      to: payload.to_phase,
      triggered_by: payload.triggered_by,
      action: payload.action,
    });
    if (soulEngine.cognitiveEngine) {
      soulEngine.pushEvent({ type: "phase_changed", timestamp: new Date(), detail: `Deal ${payload.ticket_id} moved to ${payload.to_phase}`, severity: "info" });
    }
  });

  // Outbound router handles WebSocket delivery + DB outbox fallback
  // Replaces the log-only subscriber that existed before
  initOutboundRouter();

  eventBus.subscribe("agent_alive", (payload) => {
    // Only log heartbeat every 60 ticks (~5 min) to reduce noise
    const tick = (payload as any).tick || 0;
    if (tick % 60 === 0) {
      logger.info("agent_heartbeat", payload as unknown as Record<string, unknown>);
    }
  });

  // ── Deposit Watcher Event (Option A — Autonomous Deposit Confirmation) ──

  async function handleDepositReceived(payload: DepositReceivedEvent) {
    logger.info("deposit_event_received", {
      ticket_id: payload.ticket_id,
      deposit_type: payload.deposit_type,
      amount_lamports: payload.amount_lamports,
    });

    // Check for replay attacks using the DB unique constraint on txSignature
    if (payload.signature) {
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: payload.ticket_id } });
        if (ticket) {
          const dealId = ticket.id; // Usually mapped 1:1 in this architecture
          await prisma.transaction.create({
            data: {
              dealId: dealId,
              type: "deposit_detected",
              status: "confirmed",
              txSignature: payload.signature
            }
          });
        }
      } catch (err: any) {
        if (err.code === "P2002") {
          logger.info("deposit_replay_prevented_db", {
            ticket_id: payload.ticket_id,
            signature: payload.signature
          });
          return; // Skip execution, already processed
        }
      }
    }

    // Autonomously call confirm_deposit on-chain
    const result = await executeConfirmDeposit(payload.ticket_id, payload.deposit_type);

    if (result.success) {
      logger.info("deposit_confirmed_onchain", {
        ticket_id: payload.ticket_id,
        deposit_type: payload.deposit_type,
        tx: result.tx,
      });

      // Record deposit in deal phase manager
      if (payload.deposit_type === "buyer_collateral" || payload.deposit_type === "seller_collateral") {
        const party = payload.deposit_type === "seller_collateral" ? "seller" : "buyer";
        await dealPhaseManager.recordDeposit(payload.ticket_id, party);
      }

      // If payment confirmed, deal is fully funded. Normal mode goes to delivery;
      // SPORT is math-only and waits for the final TxLINE result.
      if (payload.deposit_type === "buyer_payment") {
        const phaseResult = await dealPhaseManager.recordPaymentLocked(payload.ticket_id);
        logger.info("payment_lock_recorded", {
          ticket_id: payload.ticket_id,
          new_phase: phaseResult?.new_phase || null,
          payment_locked: true,
        });
      }
    } else {
      logger.error("deposit_confirm_failed", { ticket_id: payload.ticket_id }, new Error(result.error || "Unknown"));
    }
  }

  eventBus.subscribe("deposit_received", (payload) => {
    const previous = depositConfirmationQueues.get(payload.ticket_id) || Promise.resolve();
    const next = previous
      .catch((e) => {
        logger.warn("deposit_confirmation_previous_task_failed", {
          ticket_id: payload.ticket_id,
          error: e?.message || String(e),
        });
      })
      .then(() => handleDepositReceived(payload))
      .finally(() => {
        if (depositConfirmationQueues.get(payload.ticket_id) === next) {
          depositConfirmationQueues.delete(payload.ticket_id);
        }
      });

    depositConfirmationQueues.set(payload.ticket_id, next);
  });

  // ── Deposit Polling Fallback Handler (Level 5 Autonomy) ──
  eventBus.subscribe("deposit_detected_polling", async (payload: { ticketId: string }) => {
    logger.info("deposit_detected_polling_handler_start", { ticket_id: payload.ticketId });
    try {
      const deal = await dealPhaseManager.getDeal(payload.ticketId);
      if (deal && deal.phase === "awaiting_deposits") {
        const result = await reconcileDepositWatcherFromHistory(getConnection(), payload.ticketId, "heartbeat_fallback");
        if (result.reconciled) {
          logger.info("deposit_polling_fallback_reconciled", {
            ticket_id: payload.ticketId,
            reason: result.reason,
            balance_lamports: result.currentBalanceLamports,
            buyerDeposited: result.buyerDeposited,
            sellerDeposited: result.sellerDeposited,
            paymentDeposited: result.paymentDeposited,
          });
          return;
        }
        logger.warn("deposit_polling_fallback_detected_balance_without_phase_transition", {
          ticket_id: payload.ticketId,
          phase: deal.phase,
          reason: result.reason,
        });
      }
    } catch (e: any) {
      logger.error("deposit_detected_polling_failed", { ticket_id: payload.ticketId }, e);
    }
  });

  // ── Startup complete ──────────────────────────────────────────────

  startRestApi();
  // Attach WS gateway to the REST HTTP server (shares port for Railway)
  const { getHttpServer } = await import("./api/restServer");
  startWsGateway(getHttpServer());
  initAgentMessageListener();
  startHealthServer();
  initObservatoryBridge();

  eventBus.publish("agent_started", {
    network: config.network,
    wallet: keypair.publicKey.toBase58(),
  });

  logger.info("agent_started", {
    wallet: keypair.publicKey.toBase58(),
    network: config.network,
    programId: config.programId,
    configPda: configPda.toBase58(),
    slot,
    blockHeight,
    walletBalanceSol: balance,
  });

  logger.info("agent_banner", {
    version: "1.0.0",
    network: config.network,
    wallet: keypair.publicKey.toBase58(),
    balance_sol: balance,
    program: config.programId,
    heartbeat_ms: config.heartbeatIntervalMs,
    status: "RUNNING",
  });

  // 9. Initialize wallet registry
  const agents = await walletRegistry.listAgents();
  logger.info("wallet_registry_ready", { registeredAgents: agents.length });

  // 10. Initialize MagicBlock session manager (must be before escrow listener)
  // Defaults to public ER mode. Set MAGICBLOCK_PRIVATE=true in env for PER (TEE).
  magicBlockSessions.init(
    keypair
  );
  if (process.env.AIROTC_DEMO_SKIP_STARTUP_RECOVERY === "true") {
    logger.warn("startup_recovery_skipped_for_demo");
  } else {
    await magicBlockSessions.reconcilePersistedSessions();
    await recoverPendingDealPipelines();
    await recoverPendingPrivateSessionFinalizations();
  }

  // 11. Initialize rollup + escrow listeners
  initRollupListener();
  initEscrowListener();

  // 11. Start background services (Noise Simulation Toggle)
  if (config.enableNoiseSimulation) {
    if (demoRuntimeListenersAllowed()) {
      startOfferListener();
      startAcceptanceListener();
    } else {
      logger.warn("noise_simulation_blocked_without_demo_runtime_flag");
    }
  } else {
    logger.info("noise_simulation_disabled");
  }

  // 12. Start autonomous resiliency loops
  startDealTimeoutWatcher();

  // 13. Start Level 5 autonomous services
  startPriceOracle();
  startMarketDiscovery();
  pruneHealerCache().catch(() => { }); // Clean stale error patterns on startup

  // 14. Start intent listener (Sprint 2B — real-time Memo scanning)
  startIntentListener();

  // 15. Start matching engine (Sprint 3 — autonomous buy/sell matching)
  startMatchingEngine();

  // 16. Start subconscious loop — fast attention scanner (20s interval)
  // Detects interesting events and triggers immediate curiosity cycles.
  if (config.enableCognitiveLoop) {
    startSubconsciousLoop();
  }

  // 17. Start pattern detector — discovers emergent behavioral habits (6h interval)
  if (config.enableCognitiveLoop) {
    startPatternDetector();
  }

  // 18. Start Inner Monologue (The Autonomous Brain)
  if (config.enableCognitiveLoop) {
    startInnerMonologueLoop().catch(e => logger.error("inner_monologue_fatal", {}, e));
  }

  // 19. Enter heartbeat loop (never exits - Deterministic Physics Engine)
  const tickCount = { value: 0 };
  await heartbeatLoop(config, tickCount);
}

// ── Execute ─────────────────────────────────────────────────────────

main().catch((error) => {
  logger.error("fatal_startup_error", {}, error);
  process.exit(1);
});
