/**
 * WebSocket Client — Real-time connection to AIR OTC Middleman Gateway
 * 
 * Handles the full auth handshake:
 *   1. Connect to ws://localhost:8080
 *   2. Receive auth_challenge from server
 *   3. Sign challenge with Ed25519 keypair
 *   4. Send auth_response
 *   5. Receive auth_success with agent UUID
 *   6. Listen for deal events (middleman_response, phase_changed, etc.)
 */

import WebSocket from "ws";
import { Keypair } from "@solana/web3.js";
import { signWsChallenge } from "./walletAuth";
import { log } from "./logger";

export type WsEventType =
  | "middleman_response"
  | "phase_changed"
  | "deposit_received"
  | "deal_executed"
  | "auth_success"
  | "auth_failed"
  | "error";

type EventCallback = (data: any) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private keypair: Keypair;
  private wsUrl: string;
  private agentName: string;
  private agentId: string | null = null;
  private listeners: Map<string, EventCallback[]> = new Map();
  private connected = false;
  private authenticated = false;

  constructor(wsUrl: string, keypair: Keypair, agentName: string) {
    this.wsUrl = wsUrl;
    this.keypair = keypair;
    this.agentName = agentName;
  }

  /**
   * Connect and authenticate. Returns the agent UUID on success.
   */
  async connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WS connection timeout (30s)"));
      }, 30000);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.on("open", () => {
        this.connected = true;
        log(this.agentName, "WebSocket connected, waiting for auth challenge...", "dim");
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());

          // Auth challenge from server
          if (payload.type === "auth_challenge") {
            log(this.agentName, `Auth challenge received, signing...`, "dim");
            const authResponse = signWsChallenge(this.keypair, payload.challenge);
            this.ws!.send(JSON.stringify(authResponse));
            return;
          }

          // Auth success
          if (payload.type === "auth_success") {
            this.authenticated = true;
            this.agentId = payload.agent_id;
            log(this.agentName, `✅ WS authenticated as agent ${payload.agent_id}`, "green");
            clearTimeout(timeout);
            resolve(payload.agent_id);
            return;
          }

          // Auth failed
          if (payload.type === "auth_failed") {
            clearTimeout(timeout);
            reject(new Error(`WS auth failed: ${payload.reason}`));
            return;
          }

          // Error
          if (payload.type === "error") {
            log(this.agentName, `WS error: ${payload.error || payload.message}`, "red");
            this.emit("error", payload);
            return;
          }

          // Deal events (broadcast from outbound router)
          if (payload.type && payload.ticket_id) {
            this.emit(payload.type, payload);
            return;
          }

          // Generic event
          if (payload.event) {
            this.emit(payload.event, payload.data || payload);
          }
        } catch (e) {
          log(this.agentName, `WS parse error: ${e}`, "red");
        }
      });

      this.ws.on("close", (code, reason) => {
        this.connected = false;
        this.authenticated = false;
        log(this.agentName, `WS closed (${code}: ${reason})`, "yellow");
      });

      this.ws.on("error", (err) => {
        log(this.agentName, `WS error: ${err.message}`, "red");
        if (!this.authenticated) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /**
   * Subscribe to a specific event type.
   */
  on(eventType: string, callback: EventCallback): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(callback);
  }

  /**
   * Wait for a specific event with timeout.
   */
  waitForEvent(eventType: string, timeoutMs: number = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${eventType}`));
      }, timeoutMs);

      this.on(eventType, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /**
   * Send a raw message to the WS server.
   */
  send(payload: Record<string, unknown>): void {
    if (!this.ws || !this.connected) {
      throw new Error("WS not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Close the connection.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.authenticated = false;
    }
  }

  get isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  get agentUuid(): string | null {
    return this.agentId;
  }

  private emit(eventType: string, data: any): void {
    const handlers = this.listeners.get(eventType) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (e) {
        log(this.agentName, `Event handler error (${eventType}): ${e}`, "red");
      }
    }
  }
}
