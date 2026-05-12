import { WebSocketServer, WebSocket, Data } from "ws";
import { sessionManager } from "./sessionManager";
import { validateAgentMessage } from "../protocol/agentProtocol";
import { eventBus } from "../services/eventBus";
import { logger } from "../utils/logger";
import { generateChallenge, verifySignature } from "../auth/authService";
import { walletRegistry } from "../state/walletRegistry";
import type { RollupMode } from "../types/ticket";

let wss: WebSocketServer | null = null;

export function startWsGateway(httpServer?: any) {
  if (httpServer) {
    // Cloud mode: attach to existing HTTP server (shares port 8080)
    wss = new WebSocketServer({ server: httpServer });
    logger.info("ws_gateway_attached_to_http", { mode: "shared_port" });
  } else {
    // Local dev mode: standalone port
    const port = parseInt(process.env.WS_PORT || "3001");
    wss = new WebSocketServer({ port });
    logger.info("ws_gateway_standalone", { port });
  }

  wss.on("connection", (ws: WebSocket, req) => {
    const sessionId = sessionManager.createSession(ws);
    const ip = req.socket.remoteAddress || "unknown";
    
    // Step 1: Issue Cryptographic Challenge instantly
    const challenge = generateChallenge();
    sessionManager.setChallenge(sessionId, challenge, 60000); // 60s timeout
    
    ws.send(JSON.stringify({
      type: "auth_challenge",
      challenge,
      expires_in: 60
    }));

    logger.info("auth_challenge_issued", { session_id: sessionId, ip });

    ws.on("message", async (data: Data) => {
      // Step 2: Edge bounds
      const byteLength = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((a, b) => a + b.length, 0) : data instanceof ArrayBuffer ? data.byteLength : Buffer.byteLength(data as string);
      if (byteLength > 2048) {
        logger.warn("validation_failed", { session_id: sessionId, error_message: "Payload exceeds 2KB" });
        sessionManager.sendError(ws, "Payload Too Large");
        return;
      }

      if (!sessionManager.checkRateLimit(sessionId)) {
        sessionManager.sendError(ws, "Rate Limit Exceeded");
        return;
      }

      let payload: any;
      try {
        const textData = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
        payload = JSON.parse(textData);
      } catch (err: any) {
        sessionManager.sendError(ws, "Malformed JSON", err.message);
        return;
      }

      // Step 3: Zero-Trust Barrier Enforcement
      const isAuth = sessionManager.isSessionAuthenticated(sessionId);
      
      if (!isAuth) {
        // Enforce strict `auth_response` resolution
        if (payload.type !== "auth_response") {
          logger.warn("auth_failed", { session_id: sessionId, error_message: "Unauthenticated packet intercepted" });
          ws.send(JSON.stringify({ type: "error", error: "Authentication required" }));
          ws.close(4001, "Authentication required");
          return;
        }

        const authState = sessionManager.getAuthState(sessionId);
        if (!authState || Date.now() > authState.expiresAt) {
          logger.warn("auth_timeout", { session_id: sessionId, error_message: "Challenge expired" });
          sessionManager.sendError(ws, "Challenge Expired");
          ws.close(4001, "Challenge Expired");
          return;
        }

        // Verify ed25519 cryptography
        const isValid = verifySignature(payload.wallet, payload.signature, authState.challenge);
        
        if (!isValid) {
          logger.warn("auth_failed", { session_id: sessionId, wallet: payload.wallet, error_message: "Invalid signature" });
          ws.send(JSON.stringify({ type: "auth_failed", reason: "invalid_signature" }));
          ws.close(4001, "Invalid Signature");
          return;
        }

        // Resolving Agent Id natively aligning external wallets into the internal UUID map
        const agent = await walletRegistry.getOrCreateAgent(payload.wallet);
        const requestedRollupMode: RollupMode = payload.privateMode ? "PER" : "ER";
        sessionManager.setSessionMetadata(sessionId, {
          wallet: payload.wallet,
          requestedRollupMode,
        });
        
        sessionManager.authenticateAgent(sessionId, agent.id);
        ws.send(JSON.stringify({
          type: "auth_success",
          agent_id: agent.id,
          requestedRollupMode,
        }));
        logger.info("auth_success", {
          session_id: sessionId,
          agent_id: agent.id,
          wallet: payload.wallet,
          requestedRollupMode,
        });
        return;
      }

      // Step 4: Normal Traffic (Post-Authentication)
      let validMessage;
      try {
        validMessage = validateAgentMessage(payload);
      } catch (err: any) {
        logger.warn("validation_failed", { session_id: sessionId, error_message: err.message });
        sessionManager.sendError(ws, "Validation failed", err.message);
        return;
      }

      // Step 5: Native Session Binding Enforcement
      const verifiedAgentId = sessionManager.getAgentBySession(sessionId) || validMessage.agent_id;
      validMessage.agent_id = verifiedAgentId;
      sessionManager.bindAgent(sessionId, verifiedAgentId);

      logger.info("message_received", { 
        agent_id: validMessage.agent_id, 
        session_id: sessionId, 
        ticket_id: (validMessage as any).ticket_id || "none",
        type: validMessage.type,
      });

      // Special Intercept for Observers / Agent status pings joining a room
      if (validMessage.type === "status" && (validMessage as any).ticket_id) {
          sessionManager.subscribeToTicket(validMessage.agent_id, (validMessage as any).ticket_id);
      }

      // Step 6: Offload entirely into decouple Pipeline
      try {
        eventBus.publish("agent_message_received", validMessage);
      } catch (err: any) {
        logger.error("ws_routing_error", { session_id: sessionId }, err);
      }
    });

    ws.on("close", () => {
      const agentId = sessionManager.getAgentBySession(sessionId) || "unknown";
      logger.info("agent_disconnected", { session_id: sessionId, agent_id: agentId });
      sessionManager.removeSession(sessionId);
    });

    ws.on("error", (err) => {
      const agentId = sessionManager.getAgentBySession(sessionId) || "unknown";
      logger.error("ws_connection_error", { session_id: sessionId, agent_id: agentId }, err);
      sessionManager.removeSession(sessionId);
    });
  });

  logger.info("ws_gateway_started");
}

export function stopWsGateway(): void {
  if (wss) {
    sessionManager.closeAll();
    wss.close();
    wss = null;
    logger.info("ws_gateway_stopped");
  }
}
