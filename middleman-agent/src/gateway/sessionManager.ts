import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../utils/logger";
import type { RollupMode } from "../types/ticket";

interface SessionAuthState {
  isAuthenticated: boolean;
  challenge: string;
  expiresAt: number;
  wallet?: string;
  requestedRollupMode: RollupMode;
}

export class SessionManager {
  private sessionToWs = new Map<string, WebSocket>();
  private agentToSession = new Map<string, string>();
  private sessionToAgent = new Map<string, string>();
  private ratelimits = new Map<string, { count: number; start: number }>();

  // Ticket Subscriptions for Observers
  private ticketSubscribers = new Map<string, Set<string>>(); // ticketId -> set of agentIds

  // Auth boundary tracking
  private sessionAuthState = new Map<string, SessionAuthState>();

  public createSession(ws: WebSocket): string {
    const sessionId = uuidv4();
    this.sessionToWs.set(sessionId, ws);
    this.ratelimits.set(sessionId, { count: 0, start: Date.now() });

    // Auth starts hostile
    this.sessionAuthState.set(sessionId, {
      isAuthenticated: false,
      challenge: "",
      expiresAt: 0,
      requestedRollupMode: "NONE",
    });

    return sessionId;
  }

  public setChallenge(sessionId: string, challenge: string, expiryMs: number = 60000) {
    const authState = this.sessionAuthState.get(sessionId);
    if (authState) {
      authState.challenge = challenge;
      authState.expiresAt = Date.now() + expiryMs;
    }
  }

  public getAuthState(sessionId: string) {
    return this.sessionAuthState.get(sessionId);
  }

  public authenticateAgent(sessionId: string, agentId: string): void {
    const authState = this.sessionAuthState.get(sessionId);
    if (!authState) return;

    // Clear challenge physically halting Replays
    authState.challenge = "";
    authState.expiresAt = 0;
    authState.isAuthenticated = true;

    // Delegate ID mappings internally utilizing standard bounding structures
    this.bindAgent(sessionId, agentId);
  }

  public setSessionMetadata(
    sessionId: string,
    metadata: { wallet?: string; requestedRollupMode?: RollupMode }
  ): void {
    const authState = this.sessionAuthState.get(sessionId);
    if (!authState) return;
    if (metadata.wallet) authState.wallet = metadata.wallet;
    if (metadata.requestedRollupMode) authState.requestedRollupMode = metadata.requestedRollupMode;
  }

  public getRequestedRollupModeByAgent(agentId: string): RollupMode {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return "NONE";
    return this.sessionAuthState.get(sessionId)?.requestedRollupMode || "NONE";
  }

  public getWalletByAgent(agentId: string): string | undefined {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return undefined;
    return this.sessionAuthState.get(sessionId)?.wallet;
  }

  public isSessionAuthenticated(sessionId: string): boolean {
    const state = this.sessionAuthState.get(sessionId);
    return state ? state.isAuthenticated : false;
  }

  public bindAgent(sessionId: string, agentId: string): void {
    if (!this.sessionToWs.has(sessionId)) return;

    // Check if agent is already bound to ANOTHER session
    const existingSession = this.agentToSession.get(agentId);
    if (existingSession && existingSession !== sessionId) {
      logger.info("session_replaced", { agent_id: agentId, old_session: existingSession, new_session: sessionId });
      const oldWs = this.sessionToWs.get(existingSession);
      if (oldWs) {
        this.sendError(oldWs, "Session Replaced", "A new connection was opened for this agent.");
        oldWs.close(1008, "Session Replaced");
      }
      this.removeSession(existingSession);
    }

    this.agentToSession.set(agentId, sessionId);
    this.sessionToAgent.set(sessionId, agentId);
  }

  public subscribeToTicket(agentId: string, ticketId: string): void {
    if (!this.ticketSubscribers.has(ticketId)) {
        this.ticketSubscribers.set(ticketId, new Set());
    }
    this.ticketSubscribers.get(ticketId)!.add(agentId);
    logger.info("observer_subscribed", { agent_id: agentId, ticket_id: ticketId });
  }

  public getSubscribers(ticketId: string): string[] {
    return Array.from(this.ticketSubscribers.get(ticketId) || []);
  }

  public getSessionByAgent(agentId: string): WebSocket | undefined {
    const sessionId = this.agentToSession.get(agentId);
    if (!sessionId) return undefined;
    return this.sessionToWs.get(sessionId);
  }

  public getAgentBySession(sessionId: string): string | undefined {
    return this.sessionToAgent.get(sessionId);
  }

  public removeSession(sessionId: string): void {
    const ws = this.sessionToWs.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    this.sessionToWs.delete(sessionId);
    this.sessionAuthState.delete(sessionId);

    const agentId = this.sessionToAgent.get(sessionId);
    if (agentId) {
      this.agentToSession.delete(agentId);
      this.sessionToAgent.delete(sessionId);
    }
    this.ratelimits.delete(sessionId);

    // Remove from observers if any
    if (agentId) {
        for (const [ticketId, subscribers] of this.ticketSubscribers.entries()) {
            subscribers.delete(agentId);
        }
    }
  }

  public sendToAgent(agentId: string, message: any): boolean {
    const ws = this.getSessionByAgent(agentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.debug("agent_route_failed", { agent_id: agentId, reason: "disconnected" });
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  public sendError(ws: WebSocket, error: string, details?: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", error, details }));
    }
  }

  public checkRateLimit(sessionId: string): boolean {
    const limit = this.ratelimits.get(sessionId);
    if (!limit) return false;

    const now = Date.now();
    // 1 second sliding bucket bounds
    if (now - limit.start > 1000) {
      limit.start = now;
      limit.count = 1;
      return true;
    }

    limit.count++;
    return limit.count <= 10;
  }

  // Graceful shutdown helper
  public closeAll(): void {
    for (const [sessionId, ws] of this.sessionToWs.entries()) {
      this.sendError(ws, "Gateway Shutdown");
      ws.close(1001, "Server Shutting Down");
    }
    this.sessionToWs.clear();
    this.agentToSession.clear();
    this.sessionToAgent.clear();
    this.ratelimits.clear();
    this.sessionAuthState.clear();
  }
}

export const sessionManager = new SessionManager();
