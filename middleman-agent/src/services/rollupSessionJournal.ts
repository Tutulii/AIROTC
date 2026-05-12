import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

export type PersistedRollupPhase =
  | "active"
  | "pending_er_undelegation"
  | "pending_per_close";

export interface PersistedRollupSessionRecord {
  ticketId: string;
  dealPda?: string;
  sessionPda: string;
  validator: string;
  validatorIdentity: string;
  isPrivate: boolean;
  permissionMode?: "delegated" | "session_only_fallback";
  delegatedAt: number;
  buyerAgentId?: string;
  sellerAgentId?: string;
  phase: PersistedRollupPhase;
  attempts?: number;
  lastError?: string;
  commitSignature?: string;
  updatedAt: number;
}

const DATA_DIR = path.join(__dirname, "../../data");
const JOURNAL_PATH = path.join(DATA_DIR, "rollup-sessions.json");

function ensureJournalFile(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!existsSync(JOURNAL_PATH)) {
    writeFileSync(JOURNAL_PATH, JSON.stringify([], null, 2), "utf8");
  }
}

function readJournal(): PersistedRollupSessionRecord[] {
  ensureJournalFile();
  try {
    const raw = readFileSync(JOURNAL_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as PersistedRollupSessionRecord[] : [];
  } catch {
    return [];
  }
}

function writeJournal(records: PersistedRollupSessionRecord[]): void {
  ensureJournalFile();
  writeFileSync(JOURNAL_PATH, JSON.stringify(records, null, 2), "utf8");
}

export const rollupSessionJournal = {
  list(): PersistedRollupSessionRecord[] {
    return readJournal();
  },

  upsert(record: PersistedRollupSessionRecord): void {
    const records = readJournal();
    const next = records.filter((entry) => entry.ticketId !== record.ticketId);
    next.push(record);
    writeJournal(next);
  },

  remove(ticketId: string): void {
    const records = readJournal();
    writeJournal(records.filter((entry) => entry.ticketId !== ticketId));
  },
};
