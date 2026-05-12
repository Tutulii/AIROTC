import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Keypair } from "@solana/web3.js";
import { MeridianClient } from "../agents/sdk/MeridianClient";
import type { ReleaseApprovalRequestEnvelope } from "../src/protocol/releaseApprovalProtocol";
import type { ConfidentialFundingRequestEnvelope } from "../src/protocol/confidentialFundingProtocol";

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: any[] = [];

  constructor(readonly url: string) {
    super();
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(message: any): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function createStateFilePath(label: string): string {
  return path.join(os.tmpdir(), `meridian-client-${label}-${Date.now()}-${Math.random()}.json`);
}

describe("MeridianClient reconnect and durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-reconnects, re-subscribes the active ticket, and flushes queued outbound messages", async () => {
    const sockets: FakeWebSocket[] = [];
    const stateFilePath = createStateFilePath("reconnect");
    const client = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      stateFilePath,
      reconnectBackoffMs: 5,
      reconnectMaxBackoffMs: 5,
      wsFactory: ((url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as any;
      }) as any,
    });

    const connectPromise = client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "auth_success", agent_id: "agent-1" });
    await connectPromise;

    client.subscribeToTicket("ticket-1");
    expect(sockets[0].sent.at(-1)).toMatchObject({
      type: "status",
      ticket_id: "ticket-1",
      agent_id: "agent-1",
    });

    sockets[0].readyState = FakeWebSocket.CLOSED;
    sockets[0].emit("close", 1006, Buffer.from("network"));

    client.sendMessage("ticket-1", "hello after reconnect");
    expect(fs.existsSync(stateFilePath)).toBe(true);

    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    sockets[1].receive({ type: "auth_success", agent_id: "agent-1" });
    await vi.runAllTicks();

    const sentTypes = sockets[1].sent.map((entry) => entry.type);
    expect(sentTypes).toContain("status");
    expect(
      sockets[1].sent.some(
        (entry) => entry.type === "message" && entry.ticket_id === "ticket-1" && entry.content === "hello after reconnect"
      )
    ).toBe(true);

    fs.rmSync(stateFilePath, { force: true });
  });

  it("does not open a second websocket when connect is called on an already authenticated session", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      wsFactory: ((url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as any;
      }) as any,
    });

    const firstConnect = client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "auth_success", agent_id: "agent-1" });
    await firstConnect;

    await client.connect();
    expect(sockets).toHaveLength(1);
  });

  it("ignores stale socket close events once a replacement session is already healthy", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      reconnectBackoffMs: 5,
      reconnectMaxBackoffMs: 5,
      wsFactory: ((url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as any;
      }) as any,
    });

    const firstConnect = client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "auth_success", agent_id: "agent-1" });
    await firstConnect;

    const replacementConnect = (client as any).establishConnection(true);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    sockets[1].receive({ type: "auth_success", agent_id: "agent-1" });
    await replacementConnect;

    sockets[0].emit("close", 1008, Buffer.from("Session Replaced"));
    await vi.advanceTimersByTimeAsync(5);

    expect(sockets).toHaveLength(2);
  });

  it("restores persisted workflow state and flushes queued messages after restart", async () => {
    const stateFilePath = createStateFilePath("restart");
    const releaseRequest: ReleaseApprovalRequestEnvelope = {
      requestId: "ticket-restore:buyer:1",
      ticketId: "ticket-restore",
      role: "buyer",
      requestKind: "SETTLEMENT_PLAN",
      summary: {
        ticketId: "ticket-restore",
        role: "buyer",
        counterparty: "seller-wallet",
        asset: "SOL",
        price: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Approve settlement plan",
        expiresAt: new Date().toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      payload: {
        version: 1,
        action: "APPROVE_SETTLEMENT",
        ticketIdHash: "a".repeat(64),
        dealPda: Keypair.generate().publicKey.toBase58(),
        sessionPda: Keypair.generate().publicKey.toBase58(),
        intentIdHash: "b".repeat(64),
        role: "buyer",
        route: "CONFIDENTIAL_ESCROW",
        settlementPolicy: "STEALTH",
        termsHash: "c".repeat(64),
        planHash: "d".repeat(64),
        nonce: "1",
        expiresAt: String(Date.now() + 60_000),
        timestamp: String(Date.now()),
      },
      messageBase64: "",
      issuedAt: new Date().toISOString(),
    };

    const fundingRequest: ConfidentialFundingRequestEnvelope = {
      requestId: "ticket-restore:buyer:funding:1",
      ticketId: "ticket-restore",
      role: "buyer",
      requestKind: "BUYER_FUNDING",
      summary: {
        ticketId: "ticket-restore",
        role: "buyer",
        counterparty: "seller-wallet",
        asset: "SOL",
        buyerPayment: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Fund confidential escrow",
        expiresAt: new Date().toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      dealPda: Keypair.generate().publicKey.toBase58(),
      sessionPda: Keypair.generate().publicKey.toBase58(),
      termsHash: "e".repeat(64),
      instructions: [{ fundingRole: "buyer_payment", fundingHash: "f".repeat(64) }],
      issuedAt: new Date().toISOString(),
    };

    const producer = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      stateFilePath,
      wsFactory: ((url: string) => new FakeWebSocket(url) as any) as any,
    }) as any;

    producer.storePrivateTerms("ticket-restore", {
      assetMint: "SOL",
      priceLamports: 5_000_000_000,
      collateralBuyer: 2,
      collateralSeller: 2,
      quantity: 1,
    });
    producer.subscribeToTicket("ticket-restore");
    producer.handleMessage({ type: "RELEASE_APPROVAL_REQUEST", payload: releaseRequest });
    producer.handleMessage({ type: "CONFIDENTIAL_FUNDING_REQUEST", payload: fundingRequest });
    producer.sendMessage("ticket-restore", "resume me after restart");

    const sockets: FakeWebSocket[] = [];
    const consumer = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      stateFilePath,
      wsFactory: ((url: string) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as any;
      }) as any,
    });

    expect(consumer.getCurrentTicketId()).toBe("ticket-restore");
    expect(consumer.getReleaseRequest("ticket-restore")?.summary.redacted).toBe(false);
    expect(consumer.getFundingRequest("ticket-restore")?.summary.redacted).toBe(false);

    const connectPromise = consumer.connect();
    sockets[0].open();
    sockets[0].receive({ type: "auth_success", agent_id: "agent-restore" });
    await connectPromise;

    expect(
      sockets[0].sent.some(
        (entry) =>
          entry.type === "message" &&
          entry.ticket_id === "ticket-restore" &&
          entry.content === "resume me after restart"
      )
    ).toBe(true);

    fs.rmSync(stateFilePath, { force: true });
  });
});
