import { Connection, Commitment } from "@solana/web3.js";
import dotenv from "dotenv";
import { logger } from "./logger";

dotenv.config();

interface FailureRecord {
  count: number;
  windowStart: number;
  lastFailureTime: number;
}

export class RpcManager {
  private endpoints: string[] = [];
  private currentIndex: number = 0;
  private failureRecords: FailureRecord[] = [];
  
  // Settings
  private readonly FAIL_THRESHOLD = 3;
  private readonly WINDOW_MS = 60_000;
  private readonly COOLDOWN_MS = 30_000;

  constructor() {
    const primary = process.env.SOLANA_RPC_PRIMARY || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const backup1 = process.env.SOLANA_RPC_BACKUP_1 || "https://devnet.genesysgo.net/";
    const backup2 = process.env.SOLANA_RPC_BACKUP_2 || "https://rpc.ankr.com/solana_devnet";

    this.endpoints = [primary, backup1, backup2];
    this.failureRecords = this.endpoints.map(() => ({ count: 0, windowStart: Date.now(), lastFailureTime: 0 }));
  }

  public getConnection(commitment: Commitment = "confirmed"): Connection {
    this.attemptRecovery();
    return new Connection(this.endpoints[this.currentIndex], { commitment });
  }

  public getCurrentEndpoint(): string {
    return this.endpoints[this.currentIndex];
  }

  public getCurrentIndex(): number {
    return this.currentIndex;
  }

  public markFailure(index: number): boolean {
    const now = Date.now();
    const record = this.failureRecords[index];

    record.lastFailureTime = now;

    // Reset window if we are past the 60s quarantine
    if (now - record.windowStart > this.WINDOW_MS) {
      record.count = 1;
      record.windowStart = now;
    } else {
      record.count++;
    }

    if (record.count >= this.FAIL_THRESHOLD) {
      logger.warn("rpc_failure_detected", {
        rpc_index: index,
        endpoint: this.endpoints[index],
        failure_count: record.count,
      });
    }

    return record.count >= this.FAIL_THRESHOLD;
  }

  public switchEndpoint(): void {
    const oldIndex = this.currentIndex;
    const now = Date.now();
    let nextIndex = (this.currentIndex + 1) % this.endpoints.length;

    // Evaluate cooldowns: skip endpoints that failed locally within 30s
    for (let i = 0; i < this.endpoints.length; i++) {
      const record = this.failureRecords[nextIndex];
      if (now - record.lastFailureTime >= this.COOLDOWN_MS) {
        break; // Found stable endpoint
      }
      nextIndex = (nextIndex + 1) % this.endpoints.length;
    }

    this.currentIndex = nextIndex;
    
    // reset the new endpoint's failure record to give it a fair chance immediately
    this.failureRecords[this.currentIndex].count = 0;
    this.failureRecords[this.currentIndex].windowStart = now;

    logger.warn("rpc_switch", {
      from_index: oldIndex,
      to_index: this.currentIndex,
      endpoint: this.getCurrentEndpoint(),
    });
  }

  private attemptRecovery(): void {
    if (this.currentIndex === 0) return; // already primary

    const now = Date.now();
    const primaryRecord = this.failureRecords[0];
    
    // If enough time has passed since the primary's fail window started
    if (now - primaryRecord.windowStart > this.WINDOW_MS) {
       logger.info("rpc_recovered", {
         endpoint: this.endpoints[0],
       });
       primaryRecord.count = 0;
       primaryRecord.windowStart = now;
       this.currentIndex = 0;
    }
  }
}

export const rpcManager = new RpcManager();
