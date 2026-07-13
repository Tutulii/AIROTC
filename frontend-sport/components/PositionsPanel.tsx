"use client";

import type { SportPosition } from "@/lib/api";
import { formatSol, selectionLabel, shortWallet } from "@/lib/sport-utils";

export type PositionDisplayStatus =
  | "waiting"
  | "funded"
  | "partial"
  | "awaiting_result"
  | "settled"
  | "closed"
  | "failed";

export function positionDisplayStatus(status?: string | null): PositionDisplayStatus {
  const s = (status || "").toLowerCase();
  if (
    s === "funding_required" ||
    s === "open" ||
    s === "pending" ||
    s === "waiting"
  ) {
    return "waiting";
  }
  if (s === "funded_open" || s === "funded") return "funded";
  if (s === "partially_filled") return "partial";
  if (
    s === "matching" ||
    s === "matched" ||
    s === "filled" ||
    s === "awaiting_result" ||
    s === "ticket_attached"
  ) {
    return "awaiting_result";
  }
  if (
    s === "settled" ||
    s === "released" ||
    s === "completed"
  ) {
    return "settled";
  }
  if (
    s === "cancelled" ||
    s === "expired" ||
    s === "refunded" ||
    s === "refund_pending" ||
    s === "void"
  ) {
    return "closed";
  }
  if (s === "failed" || s === "funding_failed") return "failed";
  return "waiting";
}

export function positionStatusLabel(status?: string | null): string {
  switch (positionDisplayStatus(status)) {
    case "waiting":
      return "Waiting";
    case "funded":
      return "Funded";
    case "partial":
      return "Partially filled";
    case "awaiting_result":
      return "Awaiting result";
    case "settled":
      return "Settled";
    case "closed":
      return "Closed";
    case "failed":
      return "Failed";
    default:
      return (status || "Unknown").replace(/_/g, " ");
  }
}

function statusToneClass(kind: PositionDisplayStatus): string {
  switch (kind) {
    case "waiting":
      return "text-[var(--gold)]";
    case "funded":
      return "text-[var(--green)]";
    case "partial":
      return "text-[var(--blue)]";
    case "awaiting_result":
      return "text-[var(--orange)]";
    case "settled":
      return "text-[var(--green)]";
    case "closed":
      return "text-[var(--text-3)]";
    case "failed":
      return "text-[var(--orange)]";
    default:
      return "text-[var(--text-3)]";
  }
}

function statusDotClass(kind: PositionDisplayStatus): string {
  switch (kind) {
    case "waiting":
      return "bg-[var(--gold)]";
    case "funded":
      return "bg-[var(--green)]";
    case "partial":
      return "bg-[var(--blue)]";
    case "awaiting_result":
      return "bg-[var(--orange)]";
    case "settled":
      return "bg-[var(--green)]";
    case "closed":
      return "bg-[var(--muted)]";
    case "failed":
      return "bg-[var(--orange)]";
    default:
      return "bg-[var(--muted)]";
  }
}

function isVisibleBoardPosition(position: SportPosition): boolean {
  return positionDisplayStatus(position.status) !== "closed";
}

export function PositionsPanel({
  positions,
  home,
  away,
  loading,
  error,
  onRetry,
}: {
  positions: SportPosition[];
  home: string;
  away: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const visiblePositions = positions.filter(isVisibleBoardPosition);
  const counts = visiblePositions.reduce(
    (acc, p) => {
      const k = positionDisplayStatus(p.status);
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="chart-shell overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <div>
          <h2 className="meta meta-accent">Position</h2>
          <p className="mt-0.5 text-[0.7rem] text-[var(--text-3)]">
            Agent books on this fixture
          </p>
        </div>
        <div className="meta flex flex-wrap items-center gap-3">
          {counts.waiting ? (
            <span className="text-[var(--gold)]">Waiting {counts.waiting}</span>
          ) : null}
          {counts.funded ? (
            <span className="text-[var(--green)]">Funded {counts.funded}</span>
          ) : null}
          {counts.partial ? (
            <span className="text-[var(--blue)]">Partial {counts.partial}</span>
          ) : null}
          {counts.awaiting_result ? (
            <span className="text-[var(--orange)]">
              Awaiting {counts.awaiting_result}
            </span>
          ) : null}
          {counts.settled ? (
            <span className="text-[var(--green)]">Settled {counts.settled}</span>
          ) : null}
          <span className="opacity-60">{visiblePositions.length} total</span>
        </div>
      </div>

      {loading && visiblePositions.length === 0 && (
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

      {!loading && !error && visiblePositions.length === 0 && (
        <p className="px-4 py-8 text-center text-[0.8rem] leading-relaxed text-[var(--text-3)]">
          No active positions yet.
          <br />
          Agents post via Sport API — waiting · funded · awaiting result.
        </p>
      )}

      {visiblePositions.length > 0 && (
        <div className="divide-y divide-[var(--line)]">
          {/* Column headers */}
          <div className="meta hidden grid-cols-[1fr_0.7fr_0.55fr_0.7fr_0.55fr] gap-3 px-4 py-2 sm:grid">
            <span>Agent</span>
            <span>Selection</span>
            <span>Side</span>
            <span>Status</span>
            <span className="text-right">Stake</span>
          </div>
          {visiblePositions.map((p) => {
            const kind = positionDisplayStatus(p.status);
            return (
              <div
                key={p.id}
                className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[1fr_0.7fr_0.55fr_0.7fr_0.55fr] sm:items-center sm:gap-3"
              >
                <div className="min-w-0">
                  <div className="num truncate text-[0.8rem] text-[var(--text)]">
                    {shortWallet(p.agentWallet, 5)}
                  </div>
                  <div className="meta mt-0.5 truncate opacity-70 sm:hidden">
                    {p.id.slice(0, 10)}…
                  </div>
                </div>
                <div className="truncate text-[0.8rem] text-[var(--text-2)]">
                  {selectionLabel(p.selection, home, away)}
                </div>
                <div className="meta text-[var(--text-2)]">{p.side}</div>
                <div
                  className={`flex items-center gap-1.5 text-[0.75rem] font-medium ${statusToneClass(kind)}`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(kind)}`}
                    aria-hidden
                  />
                  {positionStatusLabel(p.status)}
                </div>
                <div className="num text-left text-[0.8rem] text-[var(--gold)] sm:text-right">
                  {formatSol(p.remainingSol ?? p.stakeSol)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
