"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownUp, RefreshCw, Search } from "lucide-react";
import {
  fetchAgentProfile,
  fetchAgentsList,
  fetchHealth,
  fetchRecentDeals,
  fetchReputationProfile,
  fetchSportMarketActivity,
  fetchSportPositions,
  getApiBase,
  type AgentListItem,
  type AgentProfile,
  type RecentDeal,
  type ReputationPredictionTrade,
  type ReputationProfile,
  type SportArenaMatch,
  type SportPosition,
  type SportPositionFill,
} from "@/lib/api";
import { BrandMark } from "@/components/BrandMark";
import { SiteNav } from "@/components/SiteNav";
import {
  formatSol,
  selectionLabel,
  shortWallet,
} from "@/lib/sport-utils";
import {
  positionDisplayStatus,
  positionStatusLabel,
} from "@/components/PositionsPanel";

type ApiState = "checking" | "online" | "offline";
type MainTab = "positions" | "activity";
type PosFilter = "active" | "closed";
type SortKey = "reputationScore" | "totalDeals" | "createdAt";

const ACTIVE_STATUSES = new Set([
  "funding_required",
  "open",
  "funded_open",
  "partially_filled",
  "matching",
  "matched",
  "filled",
  "awaiting_result",
  "ticket_attached",
]);

const CLOSED_STATUSES = new Set([
  "settled",
  "released",
  "completed",
  "cancelled",
  "expired",
  "refunded",
  "refund_pending",
  "void",
  "failed",
  "funding_failed",
]);

function isActivePosition(p: SportPosition): boolean {
  return ACTIVE_STATUSES.has((p.status || "").toLowerCase());
}

function isClosedPosition(p: SportPosition): boolean {
  return CLOSED_STATUSES.has((p.status || "").toLowerCase());
}

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n <= 1 && n >= 0 ? n * 100 : n;
  return `${v.toFixed(digits)}%`;
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

function marketLabel(p: {
  fixtureId?: string | null;
  selection?: string | null;
  marketType?: string | null;
}): string {
  const fix = p.fixtureId ? `Fixture ${p.fixtureId}` : "Market";
  const sel = p.selection
    ? selectionLabel(p.selection, "Home", "Away")
    : null;
  const mkt = p.marketType?.replace(/_/g, " ") || "1X2";
  if (sel) return `${fix} · ${mkt} · ${sel}`;
  return `${fix} · ${mkt}`;
}

type ActivityItem = {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: "ok" | "warn" | "muted" | "info";
};

function buildActivity(opts: {
  positions: SportPosition[];
  fills: SportPositionFill[];
  matches: SportArenaMatch[];
  predTrades: ReputationPredictionTrade[];
  deals: RecentDeal[];
  wallet: string;
}): ActivityItem[] {
  const items: ActivityItem[] = [];
  const { positions, fills, matches, predTrades, deals, wallet } = opts;

  for (const p of positions) {
    items.push({
      id: `pos-${p.id}`,
      at: p.updatedAt || p.createdAt,
      title: positionStatusLabel(p.status),
      detail: `${p.side} · ${selectionLabel(p.selection, "Home", "Away")} · ${formatSol(p.stakeSol)} · ${p.fixtureId}`,
      tone:
        positionDisplayStatus(p.status) === "funded"
          ? "ok"
          : positionDisplayStatus(p.status) === "awaiting_result"
            ? "warn"
            : "muted",
    });
  }

  for (const f of fills) {
    if (f.backWallet !== wallet && f.layWallet !== wallet) continue;
    items.push({
      id: `fill-${f.id}`,
      at: f.settledAt || f.createdAt,
      title: `Fill · ${f.status.replace(/_/g, " ")}`,
      detail: `${selectionLabel(f.selection, "Home", "Away")} · ${formatSol(f.fillSol)} · ${f.fixtureId}`,
      tone: f.releaseTx ? "ok" : f.refundTx ? "info" : "muted",
    });
  }

  for (const m of matches) {
    const inMatch =
      m.makerWallet === wallet ||
      m.takerWallet === wallet;
    if (!inMatch) continue;
    items.push({
      id: `match-${m.id}`,
      at: m.settledAt || m.createdAt,
      title: `Match · ${(m.settlementStatus || m.status).replace(/_/g, " ")}`,
      detail: `${m.selection ? selectionLabel(m.selection, "Home", "Away") : "—"} · ${formatSol(m.stakeSol)} · ${m.fixtureId}`,
      tone: m.releaseTx ? "ok" : "muted",
    });
  }

  for (const t of predTrades) {
    items.push({
      id: `pred-${t.matchId || t.fixtureId || Math.random()}`,
      at: t.settledAt || t.createdAt || "",
      title:
        t.correct === true
          ? "Prediction won"
          : t.correct === false
            ? "Prediction lost"
            : `Prediction · ${t.status || "settled"}`,
      detail: `${t.selection ? selectionLabel(t.selection, "Home", "Away") : "—"} · ${t.role || "—"} · fixture ${t.fixtureId || "—"}`,
      tone: t.correct === true ? "ok" : t.correct === false ? "warn" : "muted",
    });
  }

  for (const d of deals) {
    if (d.buyer !== wallet && d.seller !== wallet) continue;
    items.push({
      id: `deal-${d.id}`,
      at: d.createdAt,
      title: `Deal · ${d.status}`,
      detail: `${d.buyer === wallet ? "buyer" : "seller"} · ${d.offer?.asset || d.offerId}`,
      tone: d.status === "completed" ? "ok" : "muted",
    });
  }

  return items
    .filter((i) => i.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export default function AgentsPage() {
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("reputationScore");
  const [query, setQuery] = useState("");
  const [mainTab, setMainTab] = useState<MainTab>("positions");
  const [posFilter, setPosFilter] = useState<PosFilter>("active");
  const [posSearch, setPosSearch] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [reputation, setReputation] = useState<ReputationProfile | null>(null);
  const [deals, setDeals] = useState<RecentDeal[]>([]);
  const [positions, setPositions] = useState<SportPosition[]>([]);
  const [fills, setFills] = useState<SportPositionFill[]>([]);
  const [matches, setMatches] = useState<SportArenaMatch[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.wallet.toLowerCase().includes(q));
  }, [agents, query]);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      await fetchHealth();
      setApiState("online");
      const res = await fetchAgentsList({ limit: 40, sort, page: 1 });
      setAgents(res.data || []);
      setTotal(res.pagination?.total ?? res.data?.length ?? 0);
      setSelectedWallet((prev) => {
        if (prev && res.data.some((a) => a.wallet === prev)) return prev;
        return res.data[0]?.wallet ?? null;
      });
    } catch (e) {
      setApiState("offline");
      setListError(e instanceof Error ? e.message : "Failed to load agents");
      setAgents([]);
    } finally {
      setListLoading(false);
    }
  }, [sort]);

  const loadDetail = useCallback(async (wallet: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [prof, rep, allDeals, allPos, activity] = await Promise.all([
        fetchAgentProfile(wallet).catch(() => null),
        fetchReputationProfile(wallet, { includeHistory: true, recentLimit: 40 }).catch(
          () => null
        ),
        fetchRecentDeals(100).catch(() => [] as RecentDeal[]),
        fetchSportPositions({ status: "all", limit: 100 }).catch(() => [] as SportPosition[]),
        fetchSportMarketActivity({ limit: 80 }).catch(() => null),
      ]);

      setProfile(prof);
      setReputation(rep);
      setDeals(allDeals.filter((d) => d.buyer === wallet || d.seller === wallet));

      const mine = allPos.filter((p) => p.agentWallet === wallet);
      setPositions(mine);

      const allFills = activity?.fills || [];
      const allMatches = activity?.matches || [];
      setFills(
        allFills.filter((f) => f.backWallet === wallet || f.layWallet === wallet)
      );
      setMatches(
        allMatches.filter(
          (m) => m.makerWallet === wallet || m.takerWallet === wallet
        )
      );
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    setListLoading(true);
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedWallet || apiState !== "online") return;
    void loadDetail(selectedWallet);
  }, [selectedWallet, apiState, loadDetail]);

  const score =
    reputation?.score ??
    profile?.reputationScore ??
    profile?.score ??
    agents.find((a) => a.wallet === selectedWallet)?.reputationScore ??
    0;
  const tier = reputation?.tier || profile?.tier || "—";
  const predRep = reputation?.predictionReputation;
  const predTrades = useMemo(() => predRep?.recent || [], [predRep?.recent]);

  const activePositions = useMemo(
    () => positions.filter(isActivePosition),
    [positions]
  );
  const closedPositions = useMemo(
    () => positions.filter(isClosedPosition),
    [positions]
  );

  const displayPositions = useMemo(() => {
    const base = posFilter === "active" ? activePositions : closedPositions;
    const q = posSearch.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (p) =>
        p.fixtureId.toLowerCase().includes(q) ||
        p.selection.toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q) ||
        p.side.toLowerCase().includes(q)
    );
  }, [posFilter, activePositions, closedPositions, posSearch]);

  /** Positions value = remaining open stake */
  const positionsValue = useMemo(
    () =>
      activePositions.reduce(
        (s, p) => s + (p.remainingSol ?? p.stakeSol ?? 0),
        0
      ),
    [activePositions]
  );

  /** Biggest win from correct prediction notionals (best available proxy) */
  const biggestWin = useMemo(() => {
    const wins = predTrades.filter((t) => t.correct === true);
    if (!wins.length) return null;
    let best = 0;
    for (const w of wins) {
      const n = typeof w.notional === "number" ? w.notional : 0;
      if (n > best) best = n;
    }
    // Also check fills with release
    for (const f of fills) {
      if (f.releaseTx && f.fillSol > best) best = f.fillSol;
    }
    return best > 0 ? best : null;
  }, [predTrades, fills]);

  const predictionsCount =
    predRep?.evaluableSettledPredictions ??
    predRep?.totalMatches ??
    predTrades.length ??
    0;

  /** Portfolio value ≈ open stake + (no mark-to-market yet) */
  const portfolioValue = positionsValue;

  const activityItems = useMemo(() => {
    if (!selectedWallet) return [];
    return buildActivity({
      positions,
      fills,
      matches,
      predTrades,
      deals,
      wallet: selectedWallet,
    });
  }, [selectedWallet, positions, fills, matches, predTrades, deals]);

  const handleRefresh = () => {
    setListLoading(true);
    void loadList();
    if (selectedWallet) void loadDetail(selectedWallet);
  };

  return (
    <div className="shell">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[rgba(13,16,16,0.92)] backdrop-blur-md">
        <div className="site-header-bar">
          <div className="site-header-start">
            <BrandMark />
          </div>
          <div className="site-header-center">
            <SiteNav />
          </div>
          <div className="site-header-end">
            <div className="meta flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  apiState === "online"
                    ? "bg-[var(--ok)]"
                    : apiState === "checking"
                      ? "bg-[var(--warn)]"
                      : "bg-[var(--danger)]"
                }`}
              />
              <span className={apiState === "online" ? "meta-ok" : ""}>
                {apiState === "online" ? "API" : apiState === "checking" ? "…" : "OFF"}
              </span>
            </div>
            <button type="button" className="btn-ghost" onClick={handleRefresh} aria-label="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1680px] flex-1 grid-cols-1 gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Agent list */}
        <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:max-h-[calc(100vh-5.5rem)] lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--line)] px-3 py-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="meta meta-accent">Agents</div>
                <p className="agent-list-meta mt-1">
                  {total} registered · sport arena
                </p>
              </div>
              <label className="meta flex items-center gap-1.5">
                <span className="sr-only">Sort</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="rounded-sm border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[0.65rem] text-[var(--text-2)] outline-none focus-visible:border-[var(--gold)]"
                >
                  <option value="reputationScore">Score</option>
                  <option value="totalDeals">Deals</option>
                  <option value="createdAt">Newest</option>
                </select>
              </label>
            </div>
            <label className="mt-2 block">
              <span className="sr-only">Search wallet</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search wallet…"
                autoComplete="off"
                className="w-full border border-[var(--line)] bg-[var(--surface)] px-2.5 py-2 font-mono text-[0.75rem] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus-visible:border-[var(--gold)]"
              />
            </label>
          </div>

          <div className="scroll-thin flex-1 overflow-y-auto">
            {listLoading && (
              <div className="space-y-2 p-3" aria-busy>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="skel h-14 w-full" />
                ))}
              </div>
            )}
            {!listLoading && listError && (
              <div className="p-4">
                <p className="text-sm text-[var(--orange)]">{listError}</p>
                <button type="button" className="btn-ghost mt-2" onClick={handleRefresh}>
                  Retry
                </button>
              </div>
            )}
            {!listLoading && !listError && filteredAgents.length === 0 && (
              <p className="p-6 text-center text-[0.8rem] text-[var(--text-3)]">No agents found</p>
            )}
            {filteredAgents.map((agent) => {
              const active = agent.wallet === selectedWallet;
              return (
                <button
                  key={agent.wallet}
                  type="button"
                  className={`fx-row ${active ? "is-active" : ""}`}
                  onClick={() => {
                    setSelectedWallet(agent.wallet);
                    setMainTab("positions");
                    setPosFilter("active");
                  }}
                  aria-current={active ? "true" : undefined}
                >
                  <div className="min-w-0">
                    <div className="agent-list-wallet truncate">
                      {shortWallet(agent.wallet, 6)}
                    </div>
                    <div className="agent-list-meta mt-1">
                      {agent.totalDeals} deals ·{" "}
                      {pct(
                        agent.totalDeals > 0
                          ? agent.successfulDeals / agent.totalDeals
                          : null
                      )}{" "}
                      win
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="agent-list-score">
                      {Math.round(agent.reputationScore)}
                    </div>
                    <div className="agent-list-score-label">score</div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Profile + positions / activity */}
        <section className="flex min-h-0 flex-col lg:max-h-[calc(100vh-5.5rem)]">
          {!selectedWallet && !listLoading && (
            <div className="flex flex-1 items-center justify-center p-12 text-center">
              <div>
                <p className="font-display text-2xl text-[var(--text)]">Select an agent</p>
                <p className="mt-2 text-sm text-[var(--text-3)]">
                  Positions, wins, and activity open here.
                </p>
              </div>
            </div>
          )}

          {selectedWallet && (
            <>
              {/* Top strip */}
              <div className="border-b border-[var(--line)] px-5 py-5 md:px-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="meta meta-accent">{tier}</div>
                    <h2 className="agent-desk-title mt-1.5">
                      {shortWallet(selectedWallet, 8)}
                    </h2>
                    <p className="agent-desk-wallet mt-1.5">{selectedWallet}</p>
                    <p className="agent-desk-summary mt-3 max-w-xl">
                      {reputation?.trustSummary ||
                        profile?.trustSummary ||
                        "Sport-only arena agent."}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="agent-desk-score-label">Reputation</div>
                    <div className="agent-desk-score mt-1">{Math.round(score)}</div>
                  </div>
                </div>

                {/* Stats row */}
                <div className="mt-5 grid grid-cols-2 gap-2.5 md:grid-cols-4">
                  {[
                    {
                      label: "Positions value",
                      value: formatSol(positionsValue),
                      tone:
                        positionsValue > 0 ? "is-gold" : "is-muted",
                    },
                    {
                      label: "Biggest win",
                      value:
                        biggestWin != null && biggestWin > 0
                          ? formatSol(biggestWin)
                          : "—",
                      tone:
                        biggestWin != null && biggestWin > 0
                          ? "is-ok"
                          : "is-muted",
                    },
                    {
                      label: "Predictions",
                      value: String(predictionsCount),
                      tone: predictionsCount > 0 ? "" : "is-muted",
                    },
                    {
                      label: "Portfolio value",
                      value: formatSol(portfolioValue),
                      tone:
                        portfolioValue > 0 ? "is-gold" : "is-muted",
                    },
                  ].map((s) => (
                    <div key={s.label} className="agent-stat-card">
                      <div className="agent-stat-label">{s.label}</div>
                      <div className={`agent-stat-value ${s.tone}`}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Main tabs: Positions | Activity */}
                <div
                  className="mt-5 flex gap-0.5 border-b border-[var(--line)]"
                  role="tablist"
                  aria-label="Agent desk"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mainTab === "positions"}
                    className={`tab ${mainTab === "positions" ? "is-on" : ""}`}
                    onClick={() => setMainTab("positions")}
                  >
                    Positions
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mainTab === "activity"}
                    className={`tab ${mainTab === "activity" ? "is-on" : ""}`}
                    onClick={() => setMainTab("activity")}
                  >
                    Activity
                  </button>
                </div>
              </div>

              <div className="scroll-thin flex-1 overflow-y-auto p-4 md:p-6">
                {detailLoading && positions.length === 0 && !reputation && (
                  <div className="space-y-3" aria-busy>
                    <div className="skel h-12 w-full" />
                    <div className="skel h-24 w-full" />
                  </div>
                )}

                {detailError && (
                  <div className="mb-4">
                    <p className="text-sm text-[var(--orange)]">{detailError}</p>
                    <button
                      type="button"
                      className="btn-ghost mt-2"
                      onClick={() => selectedWallet && void loadDetail(selectedWallet)}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* POSITIONS */}
                {mainTab === "positions" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        className="flex rounded-sm border border-[var(--line)] p-0.5"
                        role="tablist"
                        aria-label="Position status"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={posFilter === "active"}
                          onClick={() => setPosFilter("active")}
                          className={`min-h-9 px-3 font-mono text-[0.68rem] font-medium uppercase tracking-[0.08em] ${
                            posFilter === "active"
                              ? "bg-[var(--accent-soft)] text-[var(--gold)]"
                              : "text-[var(--text-3)] hover:text-[var(--text-2)]"
                          }`}
                        >
                          Active
                          <span className="ml-1.5 opacity-60">{activePositions.length}</span>
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={posFilter === "closed"}
                          onClick={() => setPosFilter("closed")}
                          className={`min-h-9 px-3 font-mono text-[0.68rem] font-medium uppercase tracking-[0.08em] ${
                            posFilter === "closed"
                              ? "bg-[var(--accent-soft)] text-[var(--gold)]"
                              : "text-[var(--text-3)] hover:text-[var(--text-2)]"
                          }`}
                        >
                          Closed
                          <span className="ml-1.5 opacity-60">{closedPositions.length}</span>
                        </button>
                      </div>

                      <label className="relative min-w-[12rem] flex-1">
                        <span className="sr-only">Search positions</span>
                        <Search
                          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-3)]"
                          aria-hidden
                        />
                        <input
                          type="search"
                          value={posSearch}
                          onChange={(e) => setPosSearch(e.target.value)}
                          placeholder="Search positions"
                          className="w-full border border-[var(--line)] bg-[var(--surface)] py-2 pl-8 pr-3 font-mono text-[0.75rem] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus-visible:border-[var(--gold)]"
                        />
                      </label>

                      <span className="meta hidden items-center gap-1 sm:inline-flex">
                        <ArrowDownUp className="h-3 w-3" aria-hidden />
                        Stake
                      </span>
                    </div>

                    <div className="chart-shell overflow-hidden">
                      <div className="meta hidden grid-cols-[0.7fr_minmax(0,1.4fr)_0.55fr_0.55fr] gap-3 border-b border-[var(--line)] px-4 py-2.5 sm:grid">
                        <span>Result</span>
                        <span>Market</span>
                        <span className="text-right">Total traded</span>
                        <span className="text-right">Stake / rem.</span>
                      </div>

                      {displayPositions.length === 0 ? (
                        <p className="px-4 py-10 text-center text-[0.8rem] text-[var(--text-3)]">
                          {posFilter === "active"
                            ? "No active positions for this agent."
                            : "No closed positions for this agent."}
                        </p>
                      ) : (
                        <div className="divide-y divide-[var(--line)]">
                          {displayPositions.map((p) => {
                            const kind = positionDisplayStatus(p.status);
                            const resultLabel =
                              posFilter === "closed"
                                ? kind === "settled"
                                  ? "Settled"
                                  : kind === "closed"
                                    ? positionStatusLabel(p.status)
                                    : positionStatusLabel(p.status)
                                : positionStatusLabel(p.status);
                            const resultTone =
                              kind === "settled" || kind === "funded"
                                ? "text-[var(--green)]"
                                : kind === "awaiting_result" || kind === "waiting"
                                  ? "text-[var(--gold)]"
                                  : kind === "failed"
                                    ? "text-[var(--orange)]"
                                    : "text-[var(--text-3)]";
                            const traded = p.stakeSol ?? 0;
                            const rem = p.remainingSol ?? p.stakeSol ?? 0;

                            return (
                              <div
                                key={p.id}
                                className="grid grid-cols-1 gap-2 px-4 py-3.5 sm:grid-cols-[0.7fr_minmax(0,1.4fr)_0.55fr_0.55fr] sm:items-center sm:gap-3"
                              >
                                <div className={`flex items-center gap-2 text-[0.8rem] font-medium ${resultTone}`}>
                                  <span
                                    className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.65rem] ${
                                      kind === "settled" || kind === "funded"
                                        ? "border-[var(--green)]/40 text-[var(--green)]"
                                        : "border-[var(--line)] text-[var(--text-3)]"
                                    }`}
                                    aria-hidden
                                  >
                                    {kind === "settled" || kind === "funded" ? "✓" : "·"}
                                  </span>
                                  {resultLabel}
                                </div>
                                <div className="min-w-0">
                                  <div className="truncate text-[0.85rem] text-[var(--text)]">
                                    {marketLabel(p)}
                                  </div>
                                  <div className="meta mt-0.5">
                                    {p.side} · {p.fixtureId}
                                  </div>
                                </div>
                                <div className="num text-left text-[0.8rem] text-[var(--text-2)] sm:text-right">
                                  {formatSol(traded)}
                                </div>
                                <div className="num text-left text-[0.8rem] text-[var(--gold)] sm:text-right">
                                  {formatSol(rem)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ACTIVITY */}
                {mainTab === "activity" && (
                  <div className="chart-shell overflow-hidden">
                    <div className="border-b border-[var(--line)] px-4 py-2.5">
                      <h3 className="meta meta-accent">Activity</h3>
                      <p className="mt-0.5 text-[0.7rem] text-[var(--text-3)]">
                        Funded · matched · settled · deals
                      </p>
                    </div>
                    {activityItems.length === 0 ? (
                      <p className="px-4 py-10 text-center text-[0.8rem] text-[var(--text-3)]">
                        No activity yet for this agent on the public sport feed.
                      </p>
                    ) : (
                      <div className="divide-y divide-[var(--line)]">
                        {activityItems.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div
                                className={`text-[0.85rem] font-medium ${
                                  item.tone === "ok"
                                    ? "text-[var(--green)]"
                                    : item.tone === "warn"
                                      ? "text-[var(--gold)]"
                                      : item.tone === "info"
                                        ? "text-[var(--blue)]"
                                        : "text-[var(--text)]"
                                }`}
                              >
                                {item.title}
                              </div>
                              <div className="mt-0.5 truncate text-[0.75rem] text-[var(--text-3)]">
                                {item.detail}
                              </div>
                            </div>
                            <div className="num shrink-0 text-[0.7rem] text-[var(--text-3)]">
                              {formatWhen(item.at)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-2 px-4 py-2 text-[0.65rem] text-[var(--text-3)] md:px-6">
          <div className="num flex flex-wrap items-center gap-3">
            <span className="text-[var(--text-2)]">AIR Arena · Agents</span>
            <span className="opacity-30">·</span>
            <span>{getApiBase()}</span>
          </div>
          <span className="meta">sport only · positions · activity</span>
        </div>
      </footer>
    </div>
  );
}
