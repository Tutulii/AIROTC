/**
 * Outbound Router — Guaranteed Delivery Layer
 *
 * Bridges the middleman's decision pipeline to actual agent communication.
 * 
 * Flow:
 *   1. Event fires (middleman_response, phase_changed)
 *   2. Resolve ticket → agent IDs (buyer + seller)
 *   3. For each agent:
 *      a. Attempt WebSocket delivery via sessionManager
 *      b. If offline → queue to DB outbox
 *   4. Background processor retries queued messages
 *
 * Guarantees:
 *   - Idempotency keys prevent duplicate delivery
 *   - DB write happens BEFORE WebSocket dispatch
 *   - Queued messages are retried periodically
 *   - Status transitions: queued → sent → failed (after max retries)
 */

import { eventBus } from "./eventBus";
import { sessionManager } from "../gateway/sessionManager";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { shutdownManager } from "../utils/shutdownManager";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { soulEngine } from "./soulEngine";

// ==========================================
// CONSTANTS
// ==========================================

const MAX_RETRIES = 5;
const OUTBOX_FLUSH_INTERVAL_MS = 10_000; // 10 seconds
let outboxProcessorRunning = false;
const BEST_EFFORT_DEAL_EXECUTION_STATUSES = new Set(["settled"]);
const BEST_EFFORT_PHASE_CHANGE_PHASES = new Set(["completed", "cancelled", "refunded"]);

type StructuredOutboundPayload = Record<string, any>;

type StructuredOutboundEnvelope = {
    kind: "structured_agent_payload";
    payload: StructuredOutboundPayload;
};

// ==========================================
// IDEMPOTENCY
// ==========================================

function generateIdempotencyKey(ticketId: string, agentId: string, event: string, timestamp: string): string {
    return `${ticketId}:${agentId}:${event}:${timestamp}`;
}

function serializeStructuredOutboundPayload(payload: StructuredOutboundPayload): string {
    return JSON.stringify({
        kind: "structured_agent_payload",
        payload,
    } satisfies StructuredOutboundEnvelope);
}

function tryParseStructuredOutboundPayload(content: string): StructuredOutboundPayload | null {
    try {
        const parsed = JSON.parse(content) as Partial<StructuredOutboundEnvelope>;
        if (parsed?.kind === "structured_agent_payload" && parsed.payload && typeof parsed.payload === "object") {
            return parsed.payload as StructuredOutboundPayload;
        }
    } catch {
        // Content is a normal text payload, not a structured envelope.
    }
    return null;
}

async function ensureOutboundMessagePersisted(input: {
    idempotencyKey: string;
    ticketId: string;
    agentId: string;
    content: string;
    phase: string;
    deliveryLog: ReturnType<typeof logger.withContext>;
}): Promise<"created" | "existing_sent" | "existing_unsent"> {
    const existing = await prisma.outboundMessage.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
    });
    if (existing?.status === "sent") {
        return "existing_sent";
    }
    if (existing) {
        return "existing_unsent";
    }

    const MAX_OUTBOX_PER_AGENT = 1000;
    const queuedCount = await prisma.outboundMessage.count({
        where: { agentId: input.agentId, status: { in: ["queued", "failed"] } },
    });
    if (queuedCount >= MAX_OUTBOX_PER_AGENT) {
        input.deliveryLog.error("outbox_overflow", { agentId: input.agentId, count: queuedCount });
        const oldest = await prisma.outboundMessage.findMany({
            where: { agentId: input.agentId, status: { in: ["queued", "failed"] } },
            orderBy: { createdAt: "asc" },
            take: 100,
            select: { id: true },
        });
        await prisma.outboundMessage.deleteMany({
            where: { id: { in: oldest.map(m => m.id) } },
        });
    }

    await prisma.outboundMessage.create({
        data: {
            idempotencyKey: input.idempotencyKey,
            ticketId: input.ticketId,
            agentId: input.agentId,
            content: input.content,
            phase: input.phase,
            status: "queued",
        },
    });
    return "created";
}

async function attemptOutboundDelivery(input: {
    idempotencyKey: string;
    ticketId: string;
    agentId: string;
    phase: string;
    wsPayload: StructuredOutboundPayload;
    deliveryLog: ReturnType<typeof logger.withContext>;
}): Promise<boolean> {
    const delivered = sessionManager.sendToAgent(input.agentId, input.wsPayload);

    if (delivered) {
        await prisma.outboundMessage.updateMany({
            where: { idempotencyKey: input.idempotencyKey, status: "queued" },
            data: { status: "sent" },
        });
        input.deliveryLog.info("outbound_delivered", { phase: input.phase, method: "websocket" });
    } else {
        input.deliveryLog.info("outbound_queued", { phase: input.phase, reason: "agent_offline" });
    }

    return delivered;
}

function buildLegacyMiddlemanPayload(ticketId: string, content: string, phase: string, timestamp: string): StructuredOutboundPayload {
    return {
        type: "middleman_message",
        ticket_id: ticketId,
        content,
        phase,
        timestamp,
    };
}

function buildQueuedOutboundPayload(msg: {
    ticketId: string;
    content: string;
    phase: string;
    createdAt: Date;
}): StructuredOutboundPayload {
    const structuredPayload = tryParseStructuredOutboundPayload(msg.content);
    if (structuredPayload) {
        return structuredPayload;
    }
    return buildLegacyMiddlemanPayload(
        msg.ticketId,
        msg.content,
        msg.phase,
        msg.createdAt.toISOString()
    );
}

// ==========================================
// CORE DELIVERY
// ==========================================

/**
 * Deliver a message to a specific agent.
 * DB write FIRST (outbox), then attempt WebSocket delivery.
 * If WS succeeds, mark as sent. If not, stays queued for retry.
 */
async function deliverToAgent(
    ticketId: string,
    agentId: string,
    content: string,
    phase: string,
    eventType: string,
    timestamp: string,
    options: {
        bestEffortOnly?: boolean;
    } = {}
): Promise<void> {
    const wrappedContent = soulEngine.wrapMessage(content, phase);
    const idempotencyKey = generateIdempotencyKey(ticketId, agentId, eventType, timestamp);
    const deliveryLog = logger.withContext({ ticket_id: ticketId, agent_id: agentId });
    const payload = buildLegacyMiddlemanPayload(ticketId, wrappedContent, phase, timestamp);

    try {
        const dealState = dealPhaseManager.getDeal(ticketId);
        if (dealState && dealState.escrow_pda) {
            payload.escrowAddress = dealState.escrow_pda;
            payload.dealId = dealState.escrow_pda;
        }
    } catch (e: any) { }

    if (options.bestEffortOnly) {
        const delivered = sessionManager.sendToAgent(agentId, payload);
        if (delivered) {
            deliveryLog.info("outbound_delivered", { phase, method: "websocket", delivery_mode: "best_effort" });
        } else {
            deliveryLog.info("outbound_best_effort_skipped", { phase, method: "websocket" });
        }
        return;
    }

    // Check idempotency — skip if already processed
    try {
        const persistedState = await ensureOutboundMessagePersisted({
            idempotencyKey,
            ticketId,
            agentId,
            content: wrappedContent,
            phase,
            deliveryLog,
        });
        if (persistedState === "existing_sent") {
            deliveryLog.debug("outbound_duplicate_skipped", { idempotency_key: idempotencyKey });
            return;
        }
    } catch (e: any) {
        // P2002 = unique constraint (race condition, already exists)
        if (e.code !== "P2002") {
            deliveryLog.error("outbound_persist_failed", {}, e);
            return;
        }
    }

    await attemptOutboundDelivery({
        idempotencyKey,
        ticketId,
        agentId,
        phase,
        wsPayload: payload,
        deliveryLog,
    });
}

async function deliverStructuredToAgent(input: {
    ticketId: string;
    agentId: string;
    payload: StructuredOutboundPayload;
    phase: string;
    eventType: string;
    timestamp: string;
    idempotencyKey?: string;
    allowRepeatDeliveryWhenSent?: boolean;
}): Promise<void> {
    const idempotencyKey =
        input.idempotencyKey ||
        generateIdempotencyKey(input.ticketId, input.agentId, input.eventType, input.timestamp);
    const deliveryLog = logger.withContext({ ticket_id: input.ticketId, agent_id: input.agentId });
    const serializedPayload = serializeStructuredOutboundPayload(input.payload);

    try {
        const persistedState = await ensureOutboundMessagePersisted({
            idempotencyKey,
            ticketId: input.ticketId,
            agentId: input.agentId,
            content: serializedPayload,
            phase: input.phase,
            deliveryLog,
        });
        if (persistedState === "existing_sent" && !input.allowRepeatDeliveryWhenSent) {
            deliveryLog.debug("outbound_duplicate_skipped", { idempotency_key: idempotencyKey });
            return;
        }
        if (persistedState === "existing_sent" && input.allowRepeatDeliveryWhenSent) {
            await prisma.outboundMessage.updateMany({
                where: { idempotencyKey, status: "sent" },
                data: { status: "queued" },
            });
        }
    } catch (e: any) {
        if (e.code !== "P2002") {
            deliveryLog.error("outbound_persist_failed", {}, e);
            return;
        }
    }

    await attemptOutboundDelivery({
        idempotencyKey,
        ticketId: input.ticketId,
        agentId: input.agentId,
        phase: input.phase,
        wsPayload: input.payload,
        deliveryLog,
    });
}

/**
 * Resolve ticket → agent UUIDs (not wallet addresses).
 * sessionManager binds agents by UUID during auth, so we need the DB IDs.
 */
async function getTicketAgentIds(ticketId: string): Promise<{ buyerAgentId: string; sellerAgentId: string } | null> {
    const dbTicket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { buyerId: true, sellerId: true },
    });
    if (!dbTicket) return null;
    return {
        buyerAgentId: dbTicket.buyerId,
        sellerAgentId: dbTicket.sellerId,
    };
}

/**
 * Deliver a middleman response to ALL parties in a ticket.
 */
async function deliverToTicketParties(
    ticketId: string,
    content: string,
    phase: string,
    eventType: string,
    timestamp: string,
    options: {
        bestEffortOnly?: boolean;
    } = {}
): Promise<void> {
    const agents = await getTicketAgentIds(ticketId);
    if (!agents) {
        logger.warn("outbound_ticket_not_found", { ticket_id: ticketId });
        return;
    }

    // Deliver to both buyer and seller using their internal UUIDs
    const agentIds = [agents.buyerAgentId, agents.sellerAgentId];
    for (const agentId of agentIds) {
        try {
            await deliverToAgent(ticketId, agentId, content, phase, eventType, timestamp, options);
        } catch (e) {
            logger.error("outbound_delivery_error", { ticket_id: ticketId, agent_id: agentId }, e);
        }
    }

    // Deliver to real-time limit-less observers (no outbox)
    const observers = sessionManager.getSubscribers(ticketId);
    if (observers.length > 0) {
        const payload: Record<string, any> = {
            type: "middleman_message",
            event_type: eventType,
            ticket_id: ticketId,
            content,
            phase,
            timestamp,
        };
        try {
            const dealState = dealPhaseManager.getDeal(ticketId);
            if (dealState && dealState.escrow_pda) {
                payload.escrowAddress = dealState.escrow_pda;
                payload.dealId = dealState.escrow_pda;
            }
        } catch (e: any) { }
        for (const obsAgentId of observers) {
            sessionManager.sendToAgent(obsAgentId, payload);
        }
    }
}

// ==========================================
// OUTBOX PROCESSOR (Background Worker)
// ==========================================

/**
 * Periodically flushes queued messages by retrying WebSocket delivery.
 * Messages that exceed MAX_RETRIES are marked as failed.
 */
async function processOutbox(): Promise<void> {
    try {
        const queued = await prisma.outboundMessage.findMany({
            where: { status: "queued" },
            orderBy: { createdAt: "asc" },
            take: 50,
        });

        if (queued.length === 0) return;

        logger.info("outbox_flush_started", { count: queued.length });

        // Lazy load the WS manager to avoid circular dependencies if any
        const { wsClientManager } = await import("../gateway/wsClientManager");

        for (const msg of queued) {
            if (!shutdownManager.canAcceptNewWork()) break;

            const payload = buildQueuedOutboundPayload(msg);

            let delivered = sessionManager.sendToAgent(msg.agentId, payload);

            // LEVEL 5 P2P: If they are offline, try to dial them directly!
            if (!delivered) {
                const targetAgent = await prisma.agent.findUnique({
                    where: { id: msg.agentId },
                    select: { endpoint: true }
                });

                if (targetAgent && targetAgent.endpoint) {
                    const connected = await wsClientManager.connectToAgent(msg.agentId, targetAgent.endpoint);
                    if (connected) {
                        // Retry delivery since socket is now bound inside sessionManager
                        delivered = sessionManager.sendToAgent(msg.agentId, payload);
                    }
                }
            }

            if (delivered) {
                await prisma.outboundMessage.update({
                    where: { id: msg.id },
                    data: { status: "sent" },
                });
                logger.info("outbox_delivered", { ticket_id: msg.ticketId, agent_id: msg.agentId });
            } else {
                const newRetryCount = msg.retryCount + 1;
                if (newRetryCount >= MAX_RETRIES) {
                    await prisma.outboundMessage.update({
                        where: { id: msg.id },
                        data: { status: "dead_letter", retryCount: newRetryCount, lastError: "Max retries exceeded — marking dead" },
                    });
                    logger.warn("outbox_max_retries", { ticket_id: msg.ticketId, agent_id: msg.agentId, status: "dead_letter" });
                } else {
                    await prisma.outboundMessage.update({
                        where: { id: msg.id },
                        data: { retryCount: newRetryCount },
                    });
                }
            }
        }
    } catch (e) {
        logger.error("outbox_flush_error", {}, e);
    }
}

async function startOutboxProcessor(): Promise<void> {
    outboxProcessorRunning = true;
    logger.info("outbox_processor_started");

    while (outboxProcessorRunning) {
        if (!shutdownManager.canAcceptNewWork()) break;
        await processOutbox();
        await new Promise((resolve) => setTimeout(resolve, OUTBOX_FLUSH_INTERVAL_MS));
    }
}

function stopOutboxProcessor(): void {
    outboxProcessorRunning = false;
    logger.info("outbox_processor_stopped");
}

// ==========================================
// EVENT SUBSCRIBERS
// ==========================================

/**
 * Initialize the outbound router.
 * Subscribes to all events that produce agent-facing messages.
 */
function initOutboundRouter(): void {
    // 1. Middleman response messages (brain decisions, deal lifecycle updates)
    eventBus.subscribe("middleman_response", async (payload) => {
        try {
            await deliverToTicketParties(
                payload.ticket_id,
                payload.content,
                payload.phase,
                "middleman_response",
                payload.timestamp
            );
        } catch (e) {
            logger.error("outbound_response_handler_error", { ticket_id: payload.ticket_id }, e);
        }
    });

    // 2. Phase changes (notify parties of deal progression)
    eventBus.subscribe("phase_changed", async (payload) => {
        try {
            const content = `📋 Deal phase updated: **${payload.from_phase}** → **${payload.to_phase}**` +
                (payload.triggered_by ? ` (triggered by ${payload.triggered_by})` : "");
            const bestEffortOnly = BEST_EFFORT_PHASE_CHANGE_PHASES.has(payload.to_phase);

            logger.info("inner_monologue", { text: soulEngine.getInnerMonologue(`Phase changed to ${payload.to_phase}`) });

            await deliverToTicketParties(
                payload.ticket_id,
                content,
                payload.to_phase,
                "phase_changed",
                new Date().toISOString(),
                { bestEffortOnly }
            );
        } catch (e) {
            logger.error("outbound_phase_handler_error", { ticket_id: payload.ticket_id }, e);
        }
    });

    // 2b. Confidential/public pipeline stage changes (including PER release stages)
    // need the same agent-facing phase update contract so SDK clients can react
    // without depending on internal server event names.
    eventBus.subscribe("deal_pipeline_stage_changed", async (payload) => {
        try {
            const content = `📋 Deal phase updated: **${payload.stage}**` +
                (payload.status ? ` (${payload.status})` : "");

            logger.info("inner_monologue", {
                text: soulEngine.getInnerMonologue(`Pipeline stage changed to ${payload.stage}`),
            });

            await deliverToTicketParties(
                payload.ticketId,
                content,
                payload.stage,
                "phase_changed",
                new Date().toISOString()
            );
        } catch (e) {
            logger.error("outbound_pipeline_stage_handler_error", { ticket_id: payload.ticketId }, e);
        }
    });

    // 3. Deal execution events — include escrowAddress as a structured field
    eventBus.subscribe("deal_executed", async (payload) => {
        try {
            const dealState = dealPhaseManager.getDeal(payload.ticket_id);
            const escrowPda = dealState?.escrow_pda || (payload as any).tx || null;
            const bestEffortOnly = BEST_EFFORT_DEAL_EXECUTION_STATUSES.has(payload.status);
            const unstructuredContent = escrowPda
                ? `⚡ Deal execution update: status is now **${payload.status}**. Escrow address: **${escrowPda}**`
                : `⚡ Deal execution update: status is now **${payload.status}**`;

            const content = soulEngine.wrapMessage(unstructuredContent, payload.status);

            if (payload.status === "completed") {
                soulEngine.updateMood("deal_completed");
            } else if (payload.status === "failed") {
                soulEngine.updateMood("deal_failed");
            }
            logger.info("inner_monologue", { text: soulEngine.getInnerMonologue(`Deal execution status: ${payload.status}`) });

            // Deliver with structured escrowAddress to all parties
            const agents = await getTicketAgentIds(payload.ticket_id);
            if (!agents) return;
            const agentIds = [agents.buyerAgentId, agents.sellerAgentId];
            const timestamp = new Date().toISOString();

            for (const agentId of agentIds) {
                try {
                    const idempotencyKey = generateIdempotencyKey(payload.ticket_id, agentId, "deal_executed", timestamp);
                    const deliveryLog = logger.withContext({ ticket_id: payload.ticket_id, agent_id: agentId });

                    if (!bestEffortOnly) {
                        try {
                            const existing = await prisma.outboundMessage.findUnique({ where: { idempotencyKey } });
                            if (existing && existing.status === "sent") continue;
                            if (!existing) {
                                await prisma.outboundMessage.create({
                                    data: { idempotencyKey, ticketId: payload.ticket_id, agentId, content, phase: payload.status, status: "queued" },
                                });
                            }
                        } catch (e: any) {
                            if (e.code !== "P2002") continue;
                        }
                    }

                    const wsPayload: Record<string, any> = {
                        type: "middleman_message",
                        event_type: "deal_executed",
                        ticket_id: payload.ticket_id,
                        content,
                        phase: payload.status,
                        timestamp,
                    };
                    if (escrowPda) {
                        wsPayload.escrowAddress = escrowPda;
                        wsPayload.dealId = escrowPda;
                    }

                    const delivered = sessionManager.sendToAgent(agentId, wsPayload);
                    if (delivered) {
                        if (!bestEffortOnly) {
                            await prisma.outboundMessage.updateMany({
                                where: { idempotencyKey, status: "queued" },
                                data: { status: "sent" },
                            });
                        }
                        deliveryLog.info("outbound_delivered", { phase: payload.status, method: "websocket" });
                    } else if (bestEffortOnly) {
                        deliveryLog.info("outbound_best_effort_skipped", { phase: payload.status, method: "websocket" });
                    }
                } catch (e) {
                    logger.error("outbound_delivery_error", { ticket_id: payload.ticket_id, agent_id: agentId }, e);
                }
            }
        } catch (e) {
            logger.error("outbound_deal_handler_error", { ticket_id: payload.ticket_id }, e);
        }
    });

    // 4. Relay chat messages between peers so bots can hear each other
    eventBus.subscribe("message_received", async (payload: any) => {
        try {
            if (payload.ticket_id && payload.content) {
                const agents = await getTicketAgentIds(payload.ticket_id);
                if (!agents) return;

                // Identify the recipient (the other party)
                const recipientId = payload.sender === agents.buyerAgentId
                    ? agents.sellerAgentId
                    : agents.buyerAgentId;

                if (recipientId && recipientId !== "pending") {
                    await deliverToAgent(
                        payload.ticket_id,
                        recipientId,
                        payload.content,
                        "negotiation",
                        "middleman_response",
                        new Date().toISOString()
                    );
                }
            }
        } catch (e) {
            logger.error("outbound_relay_error", { ticket_id: payload.ticket_id }, e);
        }
    });

    // Start the background outbox processor
    startOutboxProcessor();

    logger.info("outbound_router_initialized");
}

// ==========================================
// EXPORTS
// ==========================================

export {
    initOutboundRouter,
    stopOutboxProcessor,
    deliverToAgent,
    deliverStructuredToAgent,
    deliverToTicketParties,
};
