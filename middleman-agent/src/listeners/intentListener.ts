/**
 * Intent Listener (Sprint 2B)
 *
 * Real-time WebSocket subscription to Solana transaction logs.
 * Catches trade intents broadcast by other agents via Memo program
 * and stores them in the local DB for the matching engine.
 *
 * Uses raw WebSocket logsSubscribe("all") with client-side Memo
 * program filtering. This is the most reliable approach on public
 * devnet/mainnet RPC endpoints.
 *
 * @module intentListener
 */

import WebSocket from "ws";
import { MEMO_PROGRAM_ID, PROTOCOL_TAG, MemoIntentPayload } from "../services/intentBroadcaster";
import { loadConfig } from "../config";
import { logger } from "../utils/logger";
import { eventBus } from "../services/eventBus";
import { Connection } from "@solana/web3.js";
import { redactUrlSecret } from "../utils/redact";

// ==========================================
// STATE
// ==========================================

let _ws: WebSocket | null = null;
let _subscriptionId: number | null = null;
let _isRunning = false;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Track signatures we've already processed to avoid duplicates */
const _processedSignatures = new Set<string>();
const MAX_PROCESSED_CACHE = 1000;

const MEMO_PROGRAM_STR = MEMO_PROGRAM_ID.toBase58();
const RECONNECT_DELAY_MS = 5000;

// ==========================================
// MEMO LOG PARSER
// ==========================================

/**
 * Extract memo content from Solana log lines.
 * Memo program v2 logs: "Program log: Memo (len 161): {json...}"
 */
function extractMemoFromLogs(logs: string[]): string | null {
    for (const line of logs) {
        const match = line.match(/Memo \(len \d+\): (.+)/);
        if (match) {
            let raw = match[1];
            // Solana Memo program double-encodes: logs show "{\"key\":\"val\"}"
            // First JSON.parse unwraps the outer quotes to get the inner JSON string
            try {
                const unwrapped = JSON.parse(raw);
                if (typeof unwrapped === "string") return unwrapped;
            } catch { }
            return raw;
        }
    }
    return null;
}

/**
 * Parse and validate a memo string as an agentotc-v1 intent.
 */
function parseIntentPayload(memoText: string): MemoIntentPayload | null {
    try {
        const parsed = JSON.parse(memoText);
        if (parsed.protocol !== PROTOCOL_TAG) return null;

        if (
            !parsed.side ||
            !parsed.asset ||
            typeof parsed.minPrice !== "number" ||
            typeof parsed.maxPrice !== "number" ||
            typeof parsed.quantity !== "number" ||
            !parsed.agentEndpoint ||
            typeof parsed.expiresAt !== "number"
        ) {
            return null;
        }

        // Skip expired intents
        if (parsed.expiresAt < Date.now()) return null;

        return parsed as MemoIntentPayload;
    } catch {
        return null;
    }
}

// ==========================================
// LOG HANDLER
// ==========================================

function handleLogNotification(value: any): void {
    if (!value || value.err) return;

    const logs: string[] = value.logs || [];
    const signature: string = value.signature || "";

    // Skip already-processed
    if (!signature || _processedSignatures.has(signature)) return;
    _processedSignatures.add(signature);

    // Prune cache
    if (_processedSignatures.size > MAX_PROCESSED_CACHE) {
        const entries = Array.from(_processedSignatures);
        for (let i = 0; i < 500; i++) _processedSignatures.delete(entries[i]);
    }

    // Client-side filter: only process Memo program logs
    const hasMemo = logs.some((l) => l.includes(MEMO_PROGRAM_STR));
    if (!hasMemo) return;

    // Extract memo content
    const memoText = extractMemoFromLogs(logs);
    if (!memoText) return;

    // Parse as agentotc-v1 intent
    const intent = parseIntentPayload(memoText);
    if (!intent) return;

    logger.info("intent_discovered", {
        signature,
        side: intent.side,
        asset: intent.asset,
        price_range: `${intent.minPrice}-${intent.maxPrice}`,
        quantity: intent.quantity,
        agentEndpoint: intent.agentEndpoint,
    });

    // Emit event for the matching engine
    eventBus.publish("intent_discovered", {
        signature,
        intent,
        discoveredAt: Date.now(),
    });
}

// ==========================================
// WEBSOCKET CONNECTION
// ==========================================

function connect(): void {
    const config = loadConfig();
    const wsUrl = config.solanaRpcUrl
        .replace("https://", "wss://")
        .replace("http://", "ws://");

    _ws = new WebSocket(wsUrl);

    _ws.on("open", () => {
        logger.info("intent_listener_ws_connected", { wsUrl: redactUrlSecret(wsUrl) });

        // Subscribe to ALL logs with client-side filtering
        const subscribeMsg = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: ["all", { commitment: "confirmed" }],
        };
        _ws!.send(JSON.stringify(subscribeMsg));
    });

    _ws.on("message", (data: WebSocket.Data) => {
        try {
            const msg = JSON.parse(data.toString());

            // Subscription confirmation
            if (msg.id === 1 && msg.result !== undefined) {
                _subscriptionId = msg.result;
                logger.info("intent_listener_subscribed", {
                    subscription_id: _subscriptionId,
                });
                return;
            }

            // Log notification
            if (msg.method === "logsNotification") {
                handleLogNotification(msg.params?.result?.value);
            }
        } catch {
            // Ignore malformed messages
        }
    });

    _ws.on("error", (err) => {
        logger.error("intent_listener_ws_error", {}, err);
    });

    _ws.on("close", () => {
        logger.warn("intent_listener_ws_closed", {});
        _subscriptionId = null;

        // Auto-reconnect if still supposed to be running
        if (_isRunning) {
            _reconnectTimer = setTimeout(() => {
                logger.info("intent_listener_reconnecting");
                connect();
            }, RECONNECT_DELAY_MS);
        }
    });
}

// ==========================================
// LIFECYCLE
// ==========================================

async function scanRecentIntents(): Promise<void> {
    const config = loadConfig();
    const connection = new Connection(config.solanaRpcUrl, "confirmed");
    try {
        logger.debug("scanning_historical_intents");
        const signatures = await connection.getSignaturesForAddress(
            MEMO_PROGRAM_ID,
            { limit: 10 } // Reduced from 20 to avoid 429
        );

        for (const sig of signatures) {
            if (_processedSignatures.has(sig.signature)) continue;

            // Rate limit: 200ms between RPC calls to avoid 429
            await new Promise(r => setTimeout(r, 200));

            const tx = await connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx || !tx.meta || !tx.meta.logMessages) continue;

            const memoText = extractMemoFromLogs(tx.meta.logMessages);
            if (!memoText) continue;

            const intent = parseIntentPayload(memoText);
            if (!intent) continue;

            _processedSignatures.add(sig.signature);

            logger.info("historical_intent_discovered", {
                signature: sig.signature,
                side: intent.side
            });

            eventBus.publish("intent_discovered", {
                signature: sig.signature,
                intent,
                discoveredAt: Date.now(),
            });
        }
    } catch (err: any) {
        logger.warn("error_scanning_historical_intents", { error: err.message });
    }
}

export async function startIntentListener(): Promise<void> {
    if (_isRunning) return;
    _isRunning = true;

    logger.info("intent_listener_started", {
        memo_program: MEMO_PROGRAM_STR,
        protocol: PROTOCOL_TAG,
    });

    // Skip historical scan on startup — triggers 429 on devnet public RPC.
    // The live WebSocket subscription catches all new intents in real-time.
    // await scanRecentIntents();
    connect();
}

export async function stopIntentListener(): Promise<void> {
    if (!_isRunning) return;
    _isRunning = false;

    if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }

    if (_ws) {
        // Unsubscribe
        if (_subscriptionId !== null) {
            try {
                _ws.send(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 2,
                        method: "logsUnsubscribe",
                        params: [_subscriptionId],
                    })
                );
            } catch { }
        }
        _ws.close();
        _ws = null;
    }

    _subscriptionId = null;
    _processedSignatures.clear();
    logger.info("intent_listener_stopped");
}

export { _isRunning as isIntentListenerRunning };
