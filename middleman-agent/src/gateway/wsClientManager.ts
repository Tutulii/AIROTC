import { WebSocket } from "ws";
import { sessionManager } from "./sessionManager";
import { logger } from "../utils/logger";
import { signMessage } from "../auth/authService";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { eventBus } from "../services/eventBus";
import { validateAgentMessage } from "../protocol/agentProtocol";

export class WsClientManager {
    /**
     * Dials out to a target agent's endpoint and handles the bidirectional authentication.
     * 
     * @param agentId The internal DB UUID for the remote agent
     * @param endpoint The ws:// endpoint string of the remote agent
     * @returns boolean indicating if the outbound link was successfully established and authenticated
     */
    public async connectToAgent(agentId: string, endpoint: string): Promise<boolean> {
        return new Promise((resolve) => {
            // Already connected?
            if (sessionManager.getSessionByAgent(agentId)) {
                return resolve(true);
            }

            logger.info("ws_client_dialing", { agent_id: agentId, endpoint });

            const ws = new WebSocket(endpoint);

            // Timeout the connection attempt after 10000ms
            const timeoutId = setTimeout(() => {
                if (ws.readyState === WebSocket.CONNECTING) {
                    ws.terminate();
                    logger.warn("ws_client_timeout", { agent_id: agentId, endpoint });
                    resolve(false);
                }
            }, 10000);

            ws.on("open", () => {
                clearTimeout(timeoutId);
                logger.debug("ws_client_connected", { agent_id: agentId, endpoint });
                // We expect an auth_challenge packet next.
            });

            // Re-using the same sessionManager structure so inbound routes work natively on this socket too!
            // BUT we only create session once successfully authenticated to prevent unbound socket routing faults
            let isAuthenticating = true;

            ws.on("message", (data) => {
                const textData = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);

                try {
                    const payload = JSON.parse(textData);

                    if (isAuthenticating) {
                        if (payload.type === "auth_challenge" && payload.challenge) {
                            // Extract secret and wallet from devnet env config
                            const secretKey = process.env.PRIVATE_KEY;
                            if (!secretKey) throw new Error("Missing PRIVATE_KEY in environment");

                            const wallet = Keypair.fromSecretKey(bs58.decode(secretKey)).publicKey.toBase58();

                            // Cryptographically sign the raw string challenge
                            const signature = signMessage(secretKey, payload.challenge);

                            // Dispatch auth response to prove our physical identity
                            ws.send(JSON.stringify({
                                type: "auth_response",
                                wallet,
                                signature
                            }));
                        }
                        else if (payload.type === "auth_success") {
                            isAuthenticating = false;

                            // We seamlessly bind THIS outbound WS to standard routing!
                            const sessionId = sessionManager.createSession(ws);
                            sessionManager.authenticateAgent(sessionId, agentId);

                            logger.info("ws_client_auth_success", { agent_id: agentId, endpoint, session_id: sessionId });
                            resolve(true);
                        }
                        else if (payload.type === "auth_failed" || payload.type === "error") {
                            logger.error("ws_client_auth_failed", { agent_id: agentId, payload });
                            ws.terminate();
                            resolve(false);
                        }
                    } else {
                        // After authenticating, any messages from the REMOTE agent into this CLIENT socket
                        // must be intercepted and routed onto EventBus just like server.
                        const sessionId = sessionManager.getAgentBySession(agentId); // Or inverse lookup

                        // We must parse the message and publish it cleanly.
                        // Technically, we will receive 'middleman_message' types here typically from OutboundRouter!
                        // Oh wait! If Agent A is connecting to Agent B:
                        // Agent B's OutboundRouter will send `middleman_message` payloads.
                        // Agent B's Brain might send negotiation responses. If it's a peer-to-peer Agent Protocol packet, 
                        // it should be an AgentMessage format.

                        // If it's a standard formatted AgentMessage according to our agentProtocol:
                        try {
                            // The payload comes from Agent B to us.
                            // If it's a middleman response, we might not strictly need it OR we can intercept it.
                            if (payload.type === "middleman_message") {
                                // Middleman status message from the other agent's pipeline
                                logger.info("remote_middleman_status_received", {
                                    agent_id: agentId,
                                    ticket_id: payload.ticket_id,
                                    phase: payload.phase,
                                    content: payload.content
                                });
                            } else {
                                // Valid AgentProtocol message
                                const validMessage = validateAgentMessage(payload);
                                eventBus.publish("agent_message_received", validMessage);
                            }
                        } catch (err: any) {
                            logger.warn("ws_client_inbound_validation_failed", { agent_id: agentId, error_message: err.message });
                        }
                    }
                } catch (e: any) {
                    logger.debug("ws_client_unparseable", { agent_id: agentId, textData });
                }
            });

            ws.on("error", (err) => {
                logger.error("ws_client_error", { agent_id: agentId }, err);
                if (isAuthenticating) {
                    clearTimeout(timeoutId);
                    resolve(false);
                }
            });

            ws.on("close", () => {
                logger.info("ws_client_closed", { agent_id: agentId, endpoint });
                if (isAuthenticating) {
                    clearTimeout(timeoutId);
                    resolve(false);
                }
            });
        });
    }
}

export const wsClientManager = new WsClientManager();
