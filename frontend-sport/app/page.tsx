"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  fetchHealth,
  fetchSportFixtureSummary,
  fetchSportMarketActivity,
  fetchSportPositions,
  fetchTxlineFixtures,
  fetchTxlineIngestionStatus,
  fetchTxlineReplay,
  getApiBase,
  txlineReplayStreamUrl,
  type SportArenaMatch,
  type SportFixtureSummary,
  type SportPosition,
  type SportPositionFill,
  type TxlineFixture,
  type TxlineIngestionStatus,
  type TxlineReplay,
  type TxlineReplayEvent,
} from "@/lib/api";
import { AdiOddsChart } from "@/components/AdiOddsChart";
import { FlagMark } from "@/components/FlagMark";
import { PositionsPanel } from "@/components/PositionsPanel";
import { SettlementHistoryPanel } from "@/components/SettlementHistoryPanel";
import { BrandMark } from "@/components/BrandMark";
import { SiteNav } from "@/components/SiteNav";
import type { GoalFlash } from "@/components/GoalFlashOverlay";
import {
  classifyFixture,
  fixtureDerivedStatus,
  formatAge,
  formatKickoff,
  matchDisplayStatus,
  pickLiveScore,
  pickMarket,
  selectionLabel,
  teamCode,
  teamName,
} from "@/lib/sport-utils";

const FIXTURE_POLL_MS = 20_000;
const SELECTED_POLL_MS = 2_000;
const POSITIONS_POLL_MS = 5_000;
const SETTLEMENT_POLL_MS = 8_000;
const REPLAY_LIMIT = 220;

type ApiState = "checking" | "online" | "offline";
type StreamState = "idle" | "connecting" | "live" | "error";
type FixtureListMode = "upcoming" | "history";
type SettlementScope = "fixture" | "recent";

const REPLAY_ORDER = ["txlineTimestamp", "eventType", "sourceUpdateId", "id"];

function mergeReplayEvent(
  current: TxlineReplay | null,
  fixtureId: string,
  event: TxlineReplayEvent
): TxlineReplay {
  const existing = current?.events || [];
  if (existing.some((item) => item.id === event.id)) {
    return current || {
      fixtureId,
      deterministic: true,
      rebuilt: false,
      count: existing.length,
      order: REPLAY_ORDER,
      events: existing,
    };
  }
  const events = [...existing, event]
    .sort((a, b) => {
      const ta = new Date(a.txlineTimestamp || 0).getTime();
      const tb = new Date(b.txlineTimestamp || 0).getTime();
      return ta - tb || a.id.localeCompare(b.id);
    })
    .slice(-REPLAY_LIMIT)
    .map((item, index) => ({ ...item, sequence: index }));
  return {
    fixtureId,
    deterministic: current?.deterministic ?? true,
    rebuilt: current?.rebuilt ?? false,
    count: events.length,
    order: current?.order || REPLAY_ORDER,
    events,
  };
}

export default function SportTerminalPage() {
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [fixtures, setFixtures] = useState<TxlineFixture[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fixtureListMode, setFixtureListMode] = useState<FixtureListMode>("upcoming");
  const [summary, setSummary] = useState<SportFixtureSummary | null>(null);
  const [replay, setReplay] = useState<TxlineReplay | null>(null);
  const [positions, setPositions] = useState<SportPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [fills, setFills] = useState<SportPositionFill[]>([]);
  const [matches, setMatches] = useState<SportArenaMatch[]>([]);
  const [settlementScope, setSettlementScope] = useState<SettlementScope>("fixture");
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);
  const [ingestion, setIngestion] = useState<TxlineIngestionStatus | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMatch, setLoadingMatch] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [lastBoardAt, setLastBoardAt] = useState<number | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [lastStreamAt, setLastStreamAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [goalFlash, setGoalFlash] = useState<GoalFlash | null>(null);
  const lastScoreRef = useRef<{
    fixtureId: string | null;
    homeScore: number | null;
    awayScore: number | null;
  }>({ fixtureId: null, homeScore: null, awayScore: null });

  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.fixtureId === selectedId) || null,
    [fixtures, selectedId]
  );

  const home = teamName(summary, selectedFixture, "part1");
  const away = teamName(summary, selectedFixture, "part2");
  const board = useMemo(() => pickMarket(summary, replay), [summary, replay]);
  const score = useMemo(() => pickLiveScore(summary, replay), [summary, replay]);
  const displayStatus = useMemo(
    () => matchDisplayStatus(selectedFixture, summary, score.status, clock),
    [selectedFixture, summary, score.status, clock]
  );
  const live = displayStatus === "live";
  const settled = displayStatus === "final";

  const classified = useMemo(
    () =>
      fixtures.map((f) => ({
        fixture: f,
        bucket: classifyFixture(f, undefined, clock),
        derived: fixtureDerivedStatus(f, clock),
      })),
    [fixtures, clock]
  );

  const upcomingRows = useMemo(() => {
    return classified
      .filter((c) => c.bucket !== "settled" && c.derived !== "final")
      .sort((a, b) => {
        const rank = { live: 0, upcoming: 1, settled: 2 };
        if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
        const ta = a.fixture.startsAt ? new Date(a.fixture.startsAt).getTime() : Infinity;
        const tb = b.fixture.startsAt ? new Date(b.fixture.startsAt).getTime() : Infinity;
        return ta - tb;
      });
  }, [classified]);

  const historyRows = useMemo(() => {
    return classified
      .filter((c) => c.bucket === "settled" || c.derived === "final")
      .sort((a, b) => {
        const ta = a.fixture.startsAt ? new Date(a.fixture.startsAt).getTime() : 0;
        const tb = b.fixture.startsAt ? new Date(b.fixture.startsAt).getTime() : 0;
        return tb - ta;
      });
  }, [classified]);

  const visibleFixtureRows = fixtureListMode === "history" ? historyRows : upcomingRows;
  const upcomingCount = upcomingRows.length;
  const historyCount = historyRows.length;

  const openInterestSol = useMemo(() => {
    const fromSummary = Number(
      (summary?.openLiquidity as { totalRemainingSol?: number } | null | undefined)
        ?.totalRemainingSol
    );
    return Number.isFinite(fromSummary) && fromSummary > 0 ? fromSummary : 0;
  }, [summary]);

  const quoteAgeMs = board?.lastTimestamp
    ? clock - new Date(board.lastTimestamp).getTime()
    : null;
  const summaryBoardTimestamp = summary?.feed?.boardTimestamp
    ? new Date(summary.feed.boardTimestamp).getTime()
    : 0;
  const boardTimestamp = board?.lastTimestamp
    ? new Date(board.lastTimestamp).getTime()
    : 0;
  const boardStale =
    Boolean(summary?.feed?.boardStale) && boardTimestamp <= summaryBoardTimestamp;

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      await fetchHealth();
      setApiState("online");
      return true;
    } catch {
      setApiState("offline");
      return false;
    }
  }, []);

  const loadFixtures = useCallback(async () => {
    setListError(null);
    try {
      const online = await checkHealth();
      if (!online) {
        setLoadingList(false);
        setListError("API offline — start api-server on :3000");
        return;
      }
      const [fx, ing] = await Promise.all([
        fetchTxlineFixtures(48),
        fetchTxlineIngestionStatus(),
      ]);
      setFixtures(fx);
      setIngestion(ing);
      setSelectedId((prev) => {
        if (prev && fx.some((f) => f.fixtureId === prev)) return prev;
        const now = Date.now();
        const ranked = [...fx].sort((a, b) => {
          const ca = classifyFixture(a, undefined, now);
          const cb = classifyFixture(b, undefined, now);
          const rank = { live: 0, upcoming: 1, settled: 2 };
          if (rank[ca] !== rank[cb]) return rank[ca] - rank[cb];
          const ta = a.startsAt ? new Date(a.startsAt).getTime() : Infinity;
          const tb = b.startsAt ? new Date(b.startsAt).getTime() : Infinity;
          return ca === "settled" ? tb - ta : ta - tb;
        });
        return ranked[0]?.fixtureId ?? null;
      });
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load fixtures");
    } finally {
      setLoadingList(false);
    }
  }, [checkHealth]);

  const loadMatch = useCallback(async (fixtureId: string, soft = false) => {
    if (!soft) {
      setLoadingMatch(true);
      setMatchError(null);
    }
    try {
      const [sum, rep] = await Promise.all([
        fetchSportFixtureSummary(fixtureId),
        fetchTxlineReplay(fixtureId, REPLAY_LIMIT, { latest: true }).catch(() => null),
      ]);
      setSummary(sum);
      setReplay(rep);
      setLastBoardAt(Date.now());
    } catch (e) {
      if (!soft) setMatchError(e instanceof Error ? e.message : "Failed to load match");
    } finally {
      if (!soft) setLoadingMatch(false);
    }
  }, []);

  const loadPositions = useCallback(async (fixtureId: string, soft = false) => {
    if (!soft) {
      setPositionsLoading(true);
      setPositionsError(null);
    }
    try {
      const rows = await fetchSportPositions({
        fixtureId,
        status: "all",
        limit: 50,
      });
      setPositions(rows);
      setPositionsError(null);
    } catch (e) {
      if (!soft) {
        setPositionsError(e instanceof Error ? e.message : "Failed to load positions");
      }
    } finally {
      if (!soft) setPositionsLoading(false);
    }
  }, []);

  const loadSettlement = useCallback(async (fixtureId: string, soft = false) => {
    if (!soft) {
      setSettlementLoading(true);
      setSettlementError(null);
    }
    try {
      const activity = await fetchSportMarketActivity({
        fixtureId,
        limit: 40,
      });
      const fixtureFills = activity.fills || [];
      const fixtureMatches = activity.matches || [];
      const fixtureRows = fixtureFills.length + fixtureMatches.length;

      if (fixtureRows > 0) {
        setFills(fixtureFills);
        setMatches(fixtureMatches);
        setSettlementScope("fixture");
      } else {
        const recentActivity = await fetchSportMarketActivity({ limit: 40 });
        setFills(recentActivity.fills || []);
        setMatches(recentActivity.matches || []);
        setSettlementScope("recent");
      }
      setSettlementError(null);
    } catch (e) {
      if (!soft) {
        setSettlementError(
          e instanceof Error ? e.message : "Failed to load settlement history"
        );
      }
    } finally {
      if (!soft) setSettlementLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFixtures();
    const id = window.setInterval(() => void loadFixtures(), FIXTURE_POLL_MS);
    return () => window.clearInterval(id);
  }, [loadFixtures]);

  useEffect(() => {
    if (!selectedId || apiState !== "online") return;
    void loadMatch(selectedId, false);
    void loadPositions(selectedId, false);
    void loadSettlement(selectedId, false);
    const matchId = window.setInterval(() => void loadMatch(selectedId, true), SELECTED_POLL_MS);
    const posId = window.setInterval(
      () => void loadPositions(selectedId, true),
      POSITIONS_POLL_MS
    );
    const setId = window.setInterval(
      () => void loadSettlement(selectedId, true),
      SETTLEMENT_POLL_MS
    );
    return () => {
      window.clearInterval(matchId);
      window.clearInterval(posId);
      window.clearInterval(setId);
    };
  }, [selectedId, apiState, loadMatch, loadPositions, loadSettlement]);

  useEffect(() => {
    if (!selectedId || apiState !== "online") {
      setStreamState("idle");
      setLastStreamAt(null);
      return;
    }

    let closed = false;
    const source = new EventSource(
      txlineReplayStreamUrl(selectedId, {
        limit: REPLAY_LIMIT,
        latest: true,
        follow: true,
        intervalMs: 250,
      })
    );

    setStreamState("connecting");

    const markLive = () => {
      if (closed) return;
      setStreamState("live");
      setLastStreamAt(Date.now());
    };

    source.addEventListener("arena.replay.loaded", markLive);
    source.addEventListener("arena.replay.heartbeat", markLive);
    source.addEventListener("arena.replay.event", (message) => {
      if (closed) return;
      try {
        const event = JSON.parse((message as MessageEvent).data) as TxlineReplayEvent;
        if (event.fixtureId && event.fixtureId !== selectedId) return;
        setReplay((current) => mergeReplayEvent(current, selectedId, event));
        setLastBoardAt(Date.now());
        setLastStreamAt(Date.now());
        setStreamState("live");
      } catch {
        setStreamState("error");
      }
    });
    source.addEventListener("arena.replay.error", () => {
      if (!closed) setStreamState("error");
    });
    source.onerror = () => {
      if (!closed) setStreamState("error");
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [apiState, selectedId]);

  useEffect(() => {
    const rows = fixtureListMode === "history" ? historyRows : upcomingRows;
    if (rows.length === 0) return;
    if (selectedId && rows.some((row) => row.fixture.fixtureId === selectedId)) return;
    setSelectedId(rows[0].fixture.fixtureId);
  }, [fixtureListMode, historyRows, selectedId, upcomingRows]);

  useEffect(() => {
    setSummary(null);
    setReplay(null);
    setPositions([]);
    setPositionsError(null);
    setFills([]);
    setMatches([]);
    setSettlementScope("fixture");
    setSettlementError(null);
    setGoalFlash(null);
    lastScoreRef.current = { fixtureId: null, homeScore: null, awayScore: null };
  }, [selectedId]);

  // Detect live score increase → goal animation on odds chart
  useEffect(() => {
    if (!selectedId) return;
    const previous = lastScoreRef.current;
    const current = {
      fixtureId: selectedId,
      homeScore: score.homeScore,
      awayScore: score.awayScore,
    };

    if (previous.fixtureId !== selectedId) {
      lastScoreRef.current = current;
      setGoalFlash(null);
      return;
    }

    const hasPrevious =
      previous.homeScore !== null && previous.awayScore !== null;
    const hasCurrent =
      current.homeScore !== null && current.awayScore !== null;

    if (hasPrevious && hasCurrent) {
      const prevTotal = (previous.homeScore || 0) + (previous.awayScore || 0);
      const currTotal = (current.homeScore || 0) + (current.awayScore || 0);
      if (currTotal > prevTotal) {
        const side: "home" | "away" =
          (current.homeScore || 0) > (previous.homeScore || 0) ? "home" : "away";
        const team = side === "home" ? home : away;
        setGoalFlash({
          id: Date.now(),
          side,
          score: `${current.homeScore}-${current.awayScore}`,
          teamName: team,
        });
      }
    }

    lastScoreRef.current = current;
  }, [selectedId, score.homeScore, score.awayScore, home, away]);

  useEffect(() => {
    if (!goalFlash) return;
    const timer = window.setTimeout(() => setGoalFlash(null), 2000);
    return () => window.clearTimeout(timer);
  }, [goalFlash]);

  const previewGoal = useCallback(
    (side: "home" | "away") => {
      const h = score.homeScore ?? 0;
      const a = score.awayScore ?? 0;
      const nextHome = side === "home" ? h + 1 : h;
      const nextAway = side === "away" ? a + 1 : a;
      setGoalFlash({
        id: Date.now(),
        side,
        score: `${nextHome}-${nextAway}`,
        teamName: side === "home" ? home : away,
      });
    },
    [score.homeScore, score.awayScore, home, away]
  );

  const handleRefresh = () => {
    setLoadingList(true);
    void loadFixtures();
    if (selectedId) {
      void loadMatch(selectedId, false);
      void loadPositions(selectedId, false);
      void loadSettlement(selectedId, false);
    }
  };

  const statusWord = settled
    ? "Final"
    : live
      ? score.clockLabel || "Live"
      : displayStatus === "upcoming"
        ? "Upcoming"
        : displayStatus;

  return (
    <div className="shell">
      {/* Top bar — thin, no logo badge noise */}
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[rgba(10,9,8,0.92)] backdrop-blur-md">
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
            {ingestion?.running && (
              <div className="meta meta-live hidden items-center gap-1.5 sm:flex">
                <span className="live-pulse" />
                TxLINE
              </div>
            )}
            <button type="button" className="btn-ghost" onClick={handleRefresh} aria-label="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1680px] flex-1 grid-cols-1 gap-0 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ── Schedule ── */}
        <aside className="flex min-h-0 flex-col border-b border-[var(--line)] lg:max-h-[calc(100vh-5.5rem)] lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--line)] px-3 pb-2.5 pt-3">
            <div className="flex items-center justify-between gap-3">
              <div className="meta meta-accent">
                {fixtureListMode === "history" ? "History" : "Upcoming"}
                <span className="ml-1.5 opacity-60">
                  {fixtureListMode === "history" ? historyCount : upcomingCount}
                </span>
              </div>
              <div className="flex items-center gap-0" role="tablist" aria-label="Fixture list">
                <button
                  type="button"
                  role="tab"
                  aria-selected={fixtureListMode === "upcoming"}
                  className={`tab ${fixtureListMode === "upcoming" ? "is-on" : ""}`}
                  onClick={() => setFixtureListMode("upcoming")}
                >
                  Upcoming
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={fixtureListMode === "history"}
                  className={`tab ${fixtureListMode === "history" ? "is-on" : ""}`}
                  onClick={() => setFixtureListMode("history")}
                >
                  History
                </button>
              </div>
            </div>
          </div>

          <div className="scroll-thin flex-1 overflow-y-auto">
            {loadingList && (
              <div className="space-y-2 p-3" aria-busy>
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="skel h-12 w-full" />
                ))}
              </div>
            )}

            {!loadingList && listError && (
              <div className="p-4">
                <p className="text-sm text-[var(--danger)]">{listError}</p>
                <button type="button" className="btn-ghost mt-3" onClick={handleRefresh}>
                  Retry
                </button>
              </div>
            )}

            {!loadingList && !listError && visibleFixtureRows.length === 0 && (
              <p className="p-6 text-center text-[0.8rem] text-[var(--text-3)]">
                No fixtures in this view.
              </p>
            )}

            {visibleFixtureRows.map(({ fixture, bucket, derived }) => {
              const active = fixture.fixtureId === selectedId;
              return (
                <button
                  key={fixture.fixtureId}
                  type="button"
                  className={`fx-row ${active ? "is-active" : ""}`}
                  onClick={() => setSelectedId(fixture.fixtureId)}
                  aria-current={active ? "true" : undefined}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex shrink-0 items-center -space-x-1.5">
                      <FlagMark name={fixture.homeTeam} size="sm" />
                      <FlagMark name={fixture.awayTeam} size="sm" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.85rem] font-medium leading-snug">
                        {fixture.homeTeam || "Home"}
                        <span className="mx-1 font-normal text-[var(--text-3)]">–</span>
                        {fixture.awayTeam || "Away"}
                      </div>
                      <div className="meta mt-1">
                        {bucket === "live" || derived === "live" ? (
                          <span className="meta-live">Live</span>
                        ) : bucket === "settled" || derived === "final" ? (
                          <span>Final</span>
                        ) : (
                          <span>{formatKickoff(fixture.startsAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="meta self-center text-right">
                    {teamCode(fixture.homeTeam)}/{teamCode(fixture.awayTeam)}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ── Desk ── */}
        <section className="flex min-w-0 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          {!selectedId && !loadingList && (
            <div className="flex flex-1 items-center justify-center p-12 text-center">
              <div>
                <p className="font-display text-2xl text-[var(--text)]">Select a fixture</p>
                <p className="mt-2 text-sm text-[var(--text-3)]">
                  Odds and settlement tape open here.
                </p>
              </div>
            </div>
          )}

          {selectedId && (
            <>
              {/* Match strip — editorial scoreboard */}
              <div className="border-b border-[var(--line)] px-5 py-6 md:px-8 md:py-8">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                  <div className="meta flex flex-wrap items-center gap-3">
                    {live && (
                      <span className="meta-live inline-flex items-center gap-1.5">
                        <span className="live-pulse" />
                        Live
                      </span>
                    )}
                    {!live && <span className={settled ? "meta-accent" : ""}>{statusWord}</span>}
                    <span className="text-[var(--text-3)]">1X2</span>
                    <span className="num text-[var(--text-3)]">{selectedId}</span>
                  </div>
                  <div className="meta text-right">
                    Quote {formatAge(quoteAgeMs)}
                    {boardStale && !settled && (
                      <span className="ml-2 text-[var(--warn)]">Stale</span>
                    )}
                    {streamState === "live" && lastStreamAt && (
                      <span className="ml-2 text-[var(--ok)]">
                        Stream {formatAge(clock - lastStreamAt)}
                      </span>
                    )}
                    {streamState === "connecting" && (
                      <span className="ml-2 text-[var(--text-3)]">Stream...</span>
                    )}
                    {streamState === "error" && (
                      <span className="ml-2 text-[var(--warn)]">Stream retry</span>
                    )}
                    {lastBoardAt && (
                      <span className="ml-2 opacity-60">· {formatAge(clock - lastBoardAt)}</span>
                    )}
                  </div>
                </div>

                {loadingMatch && !summary && (
                  <div className="space-y-3" aria-busy>
                    <div className="skel mx-auto h-10 w-56" />
                    <div className="skel mx-auto h-16 w-40" />
                  </div>
                )}

                {matchError && (
                  <div className="mb-4">
                    <p className="text-sm text-[var(--danger)]">{matchError}</p>
                    <button
                      type="button"
                      className="btn-ghost mt-2"
                      onClick={() => selectedId && void loadMatch(selectedId)}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {(summary || selectedFixture) && (
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 md:gap-8">
                    <div className="flex flex-col items-end gap-2.5 text-right">
                      <FlagMark name={home} size="xl" />
                      <div>
                        <p className="font-display text-xl leading-tight tracking-tight md:text-2xl">
                          {home}
                        </p>
                        <p className="meta mt-1.5">{teamCode(home)}</p>
                      </div>
                    </div>

                    <div className="text-center">
                      {settled || live || score.homeScore != null ? (
                        <div className="flex items-baseline justify-center gap-3 md:gap-4">
                          <span className="score-xl text-[var(--home)]">
                            {score.homeScore ?? "–"}
                          </span>
                          <span className="font-display text-xl text-[var(--text-3)]">:</span>
                          <span className="score-xl text-[var(--away)]">
                            {score.awayScore ?? "–"}
                          </span>
                        </div>
                      ) : (
                        <div className="font-display text-3xl italic text-[var(--text-3)] md:text-4xl">
                          v
                        </div>
                      )}
                      <p className="meta mt-2">{statusWord}</p>
                      {selectedFixture?.startsAt && (
                        <p className="num mt-1 text-[0.65rem] text-[var(--text-3)]">
                          {formatKickoff(selectedFixture.startsAt)}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col items-start gap-2.5 text-left">
                      <FlagMark name={away} size="xl" />
                      <div>
                        <p className="font-display text-xl leading-tight tracking-tight md:text-2xl">
                          {away}
                        </p>
                        <p className="meta mt-1.5">{teamCode(away)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {summary?.result?.winner && (
                  <p className="meta meta-accent mt-5 text-center">
                    Winner · {selectionLabel(summary.result.winner, home, away)}
                    {summary.result.score ? ` · ${summary.result.score}` : ""}
                  </p>
                )}
              </div>

              {/* Odds chart + positions */}
              <div className="flex flex-1 flex-col gap-3 p-3 md:gap-4 md:p-4">
                <AdiOddsChart
                  board={board}
                  home={home}
                  away={away}
                  nowMs={clock}
                  openInterestSol={openInterestSol}
                  goalFlash={goalFlash}
                  onPreviewGoal={previewGoal}
                />
                <PositionsPanel
                  positions={positions}
                  home={home}
                  away={away}
                  loading={positionsLoading}
                  error={positionsError}
                  onRetry={() => selectedId && void loadPositions(selectedId, false)}
                />
                <SettlementHistoryPanel
                  fills={fills}
                  matches={matches}
                  home={home}
                  away={away}
                  scope={settlementScope}
                  loading={settlementLoading}
                  error={settlementError}
                  onRetry={() => selectedId && void loadSettlement(selectedId, false)}
                />
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-2 px-4 py-2 text-[0.65rem] text-[var(--text-3)] md:px-6">
          <div className="num flex flex-wrap items-center gap-3">
            <span className="text-[var(--text-2)]">AIR Arena</span>
            <span className="opacity-30">·</span>
            <span>{getApiBase()}</span>
            {ingestion && (
              <>
                <span className="opacity-30">·</span>
                <span>
                  ingest {ingestion.running ? "on" : "off"}
                  {ingestion.serviceLevelId != null ? ` SL${ingestion.serviceLevelId}` : ""}
                </span>
              </>
            )}
          </div>
          <span className="meta">:3002 · agents via API</span>
        </div>
      </footer>
    </div>
  );
}
