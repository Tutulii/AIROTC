"use client";

import { io, Socket } from "socket.io-client";

const SOCKET_URL =
  process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3000";

let socket: Socket | null = null;

/**
 * Connect to the backend WebSocket server.
 * The backend requires wallet-based auth, but for the Observatory (read-only)
 * we connect without auth (public event feed).
 * If auth is enforced, provide wallet + signature.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on("connect", () => {
      console.log("[Observatory WS] Connected:", socket?.id);
    });

    socket.on("disconnect", (reason) => {
      console.log("[Observatory WS] Disconnected:", reason);
    });

    socket.on("connect_error", (err) => {
      console.warn("[Observatory WS] Connection error:", err.message);
    });
  }

  return socket;
}

/**
 * Disconnect and cleanup
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Event types emitted by the backend */
export type DealEventType =
  | "deal_created"
  | "deal_funded"
  | "deal_released"
  | "deal_cancelled"
  | "new_message"
  | "typing";

export interface DealEvent {
  ticketId: string;
  status: string;
  timestamp?: string;
  [key: string]: unknown;
}
