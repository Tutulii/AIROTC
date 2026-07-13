"use client";

import type { SportArenaMatch, SportPositionFill } from "@/lib/api";
import { formatSol, selectionLabel, shortWallet } from "@/lib/sport-utils";

export type SettlementRow = {
  id: string;
  kind: "fill" | "match";
  fixtureId: string | null;
  selection: string;
  status: string;
  stakeSol: number | null;
  parties: string;
  proof: string | null;
  at: string;
};

type SettlementScope = "fixture" | "recent";

function settlementLabel(status?: string | null): string {
  const s = (status || "").toLowerCase();
  if (s === "settled" || s === "released" || s === "completed") return "Settled";
  if (s === "refunded" || s === "refund") return "Refunded";
  if (s === "void" || s === "cancelled") return "Void";
  if (s === "failed") return "Failed";
  if (s === "awaiting_result" || s === "matched" || s === "filled" || s === "matching") {
    return "Awaiting result";
  }
  if (s === "committed" || s === "open") return "Open";
  return (status || "Unknown").replace(/_/g, " ");
}

function settlementTone(status?: string | null): string {
  const s = (status || "").toLowerCase();
  if (s === "settled" || s === "released" || s === "completed") return "text-[var(--green)]";
  if (s === "refunded" || s === "refund") return "text-[var(--blue)]";
  if (s === "void" || s === "cancelled" || s === "failed") return "text-[var(--orange)]";
  if (s === "awaiting_result" || s === "matched" || s === "filled") return "text-[var(--gold)]";
  return "text-[var(--text-3)]";
}

function settlementDot(status?: string | null): string {
  const s = (status || "").toLowerCase();
  if (s === "settled" || s === "released" || s === "completed") return "bg-[var(--green)]";
  if (s === "refunded" || s === "refund") return "bg-[var(--blue)]";
  if (s === "void" || s === "cancelled" || s === "failed") return "bg-[var(--orange)]";
  if (s === "awaiting_result" || s === "matched" || s === "filled") return "bg-[var(--gold)]";
  return "bg-[var(--muted)]";
}

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortTx(tx?: string | null): string | null {
  if (!tx) return null;
  if (tx.length <= 12) return tx;
  return `${tx.slice(0, 6)}…${tx.slice(-4)}`;
}

function rowSelectionLabel(
  row: SettlementRow,
  home: string,
  away: string,
  scope: SettlementScope
): string {
  if (scope === "recent") {
    return row.fixtureId ? `#${row.fixtureId} · ${row.selection}` : row.selection;
  }
  return selectionLabel(row.selection, home, away);
}

export function buildSettlementRows(
  fills: SportPositionFill[],
  matches: SportArenaMatch[]
): SettlementRow[] {
  const rows: SettlementRow[] = [];

  for (const f of fills) {
    rows.push({
      id: `fill-${f.id}`,
      kind: "fill",
      fixtureId: f.fixtureId,
      selection: f.selection,
      status: f.status,
      stakeSol: f.fillSol ?? null,
      parties: `${shortWallet(f.backWallet, 4)} ↔ ${shortWallet(f.layWallet, 4)}`,
      proof: f.releaseTx || f.refundTx || f.commitTx || null,
      at: f.settledAt || f.createdAt,
    });
  }

  for (const m of matches) {
    // Prefer match rows that represent settlement lifecycle
    rows.push({
      id: `match-${m.id}`,
      kind: "match",
      fixtureId: m.fixtureId,
      selection: m.selection || "—",
      status: m.settlementStatus || m.status,
      stakeSol: m.stakeSol ?? null,
      parties: m.takerWallet
        ? `${shortWallet(m.makerWallet, 4)} ↔ ${shortWallet(m.takerWallet, 4)}`
        : shortWallet(m.makerWallet, 4),
      proof: m.releaseTx || m.refundTx || null,
      at: m.settledAt || m.createdAt,
    });
  }

  return rows.sort((a, b) => {
    const ta = new Date(a.at || 0).getTime();
    const tb = new Date(b.at || 0).getTime();
    return tb - ta;
  });
}

export function SettlementHistoryPanel({
  fills,
  matches,
  home,
  away,
  scope = "fixture",
  loading,
  error,
  onRetry,
}: {
  fills: SportPositionFill[];
  matches: SportArenaMatch[];
  home: string;
  away: string;
  scope?: SettlementScope;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const rows = buildSettlementRows(fills, matches);
  const settledN = rows.filter((r) =>
    ["settled", "released", "completed"].includes((r.status || "").toLowerCase())
  ).length;
  const refundedN = rows.filter((r) =>
    ["refunded", "refund"].includes((r.status || "").toLowerCase())
  ).length;
  const pendingN = rows.filter((r) =>
    ["awaiting_result", "matched", "filled", "matching"].includes((r.status || "").toLowerCase())
  ).length;

  return (
    <div className="chart-shell overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <div>
          <h2 className="meta meta-accent">Settlement history</h2>
          <p className="mt-0.5 text-[0.7rem] text-[var(--text-3)]">
            {scope === "recent"
              ? "Recent fills, matches & on-chain outcomes"
              : "Fills, matches & on-chain outcomes"}
          </p>
        </div>
        <div className="meta flex flex-wrap items-center gap-3">
          {settledN > 0 && <span className="text-[var(--green)]">Settled {settledN}</span>}
          {refundedN > 0 && <span className="text-[var(--blue)]">Refunded {refundedN}</span>}
          {pendingN > 0 && <span className="text-[var(--gold)]">Pending {pendingN}</span>}
          <span className="opacity-60">{rows.length} total</span>
        </div>
      </div>

      {loading && rows.length === 0 && (
        <div className="space-y-2 p-4" aria-busy>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skel h-12 w-full" />
          ))}
        </div>
      )}

      {error && (
        <div className="px-4 py-3">
          <p className="text-sm text-[var(--orange)]">{error}</p>
          {onRetry && (
            <button type="button" className="btn-ghost mt-2" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="px-4 py-8 text-center text-[0.8rem] leading-relaxed text-[var(--text-3)]">
          {scope === "recent" ? "No recent settlement history yet." : "No settlement history yet."}
          <br />
          {scope === "recent"
            ? "Settled fills will appear here after completed fixtures resolve."
            : "Matched fills settle here when the fixture resolves."}
        </p>
      )}

      {rows.length > 0 && (
        <div className="divide-y divide-[var(--line)]">
          <div className="meta hidden grid-cols-[0.55fr_0.7fr_0.85fr_0.7fr_0.55fr_0.7fr] gap-3 px-4 py-2 lg:grid">
            <span>Type</span>
            <span>Selection</span>
            <span>Parties</span>
            <span>Status</span>
            <span className="text-right">Amount</span>
            <span className="text-right">When</span>
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-1 gap-1.5 px-4 py-3 lg:grid-cols-[0.55fr_0.7fr_0.85fr_0.7fr_0.55fr_0.7fr] lg:items-center lg:gap-3"
            >
              <div className="meta text-[var(--text-2)]">
                {row.kind === "fill" ? "Fill" : "Match"}
              </div>
              <div className="truncate text-[0.8rem] text-[var(--text)]">
                {rowSelectionLabel(row, home, away, scope)}
              </div>
              <div className="num truncate text-[0.75rem] text-[var(--text-3)]">{row.parties}</div>
              <div
                className={`flex flex-wrap items-center gap-1.5 text-[0.75rem] font-medium ${settlementTone(row.status)}`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${settlementDot(row.status)}`}
                  aria-hidden
                />
                {settlementLabel(row.status)}
                {row.proof && (
                  <span className="num font-normal text-[var(--text-3)]" title={row.proof}>
                    · {shortTx(row.proof)}
                  </span>
                )}
              </div>
              <div className="num text-left text-[0.8rem] text-[var(--gold)] lg:text-right">
                {formatSol(row.stakeSol)}
              </div>
              <div className="num text-left text-[0.7rem] text-[var(--text-3)] lg:text-right">
                {formatWhen(row.at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
