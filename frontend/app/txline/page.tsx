"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTxlineBacktest,
  fetchTxlineConfig,
  fetchTxlineDemoReplayProof,
  fetchTxlineFixtures,
  fetchTxlineIngestionStatus,
  fetchTxlineReplay,
  fetchTxlineSnapshotProof,
  fetchTxlineStrategyConfig,
  fetchTxlineStrategySignals,
  getTxlineReplayStreamUrl,
  type TxlineBacktest,
  type TxlineConfig,
  type TxlineDemoReplayProof,
  type TxlineFixture,
  type TxlineIngestionStatus,
  type TxlineReplay,
  type TxlineReplayEvent,
  type TxlineSnapshotProof,
  type TxlineStrategyConfig,
  type TxlineStrategySignalsResponse,
} from "@/lib/api";

type LoadError = {
  title: string;
  message: string;
};

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function settledError(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  return result.reason instanceof Error ? result.reason.message : "Request failed";
}

function shortId(value?: string | null): string {
  if (!value) return "none";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function percent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function numberLabel(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function formatDate(value?: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rawText(raw: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!raw) return null;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function fixtureName(fixture: TxlineFixture): string {
  const home = fixture.homeTeam || rawText(fixture.raw, ["Participant1", "HomeTeam", "homeTeam"]);
  const away = fixture.awayTeam || rawText(fixture.raw, ["Participant2", "AwayTeam", "awayTeam"]);
  if (home && away) return `${home} vs ${away}`;
  return fixture.fixtureId;
}

function scoreLabel(event: TxlineReplayEvent): string {
  const state = event.scoreState || {};
  const home = state.homeScore;
  const away = state.awayScore;
  const status = typeof state.status === "string" ? state.status : "score";
  if (typeof home === "number" && typeof away === "number") return `${home}-${away} ${status}`;
  return status;
}

function eventHeadline(event: TxlineReplayEvent): string {
  if (event.type === "odds") {
    return [event.marketType, event.selection].filter(Boolean).join(" / ") || "Odds update";
  }
  return scoreLabel(event);
}

function eventDetail(event: TxlineReplayEvent): string {
  if (event.type === "odds") {
    return `Odds ${numberLabel(event.oddsValue, 3)} from ${event.sourceEndpoint}`;
  }
  return `${event.sourceEndpoint} at ${formatDate(event.txlineTimestamp)}`;
}

function statusTone(value: "good" | "warn" | "bad" | "neutral"): string {
  if (value === "good") return "border-accent/30 bg-accent-bg text-accent";
  if (value === "warn") return "border-warning/30 bg-warning/10 text-warning";
  if (value === "bad") return "border-error/30 bg-error/10 text-error";
  return "border-border-subtle bg-bg-elevated text-text-secondary";
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <span className={`inline-flex min-h-8 items-center border px-3 py-1 text-xs font-bold uppercase tracking-widest ${statusTone(tone)}`}>
      {children}
    </span>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <section className="border border-border-subtle bg-bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-text-muted">{label}</p>
          <p className="mt-3 font-headline text-2xl font-semibold text-text-primary">{value}</p>
        </div>
        <span className={`material-symbols-outlined text-3xl ${tone === "good" ? "text-accent" : tone === "warn" ? "text-warning" : tone === "bad" ? "text-error" : "text-text-muted"}`} aria-hidden="true">
          {icon}
        </span>
      </div>
      <p className="mt-4 min-h-10 text-sm leading-5 text-text-secondary">{detail}</p>
    </section>
  );
}

function SkeletonPanel() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-20 skeleton" />
      <div className="h-20 skeleton" />
      <div className="h-20 skeleton" />
    </div>
  );
}

function ErrorPanel({
  error,
  onRetry,
}: {
  error: LoadError;
  onRetry: () => void;
}) {
  return (
    <section className="border border-error/30 bg-error/10 p-6">
      <div className="flex items-start gap-3">
        <span className="material-symbols-outlined mt-0.5 text-error" aria-hidden="true">
          error
        </span>
        <div className="min-w-0">
          <h2 className="font-headline text-lg font-semibold text-text-primary">{error.title}</h2>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{error.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 min-h-10 border border-border-subtle bg-bg-elevated px-4 text-sm font-bold text-text-primary transition-colors hover:bg-bg-highest focus-visible:ring-2 focus-visible:ring-accent"
          >
            Retry
          </button>
        </div>
      </div>
    </section>
  );
}

function EmptyPanel({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="border border-border-subtle bg-bg-root p-6 text-center">
      <span className="material-symbols-outlined text-4xl text-text-muted" aria-hidden="true">
        inventory_2
      </span>
      <p className="mt-3 font-headline text-sm font-semibold text-text-primary">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">{body}</p>
    </div>
  );
}

function backtestTone(backtest?: TxlineBacktest | null): "good" | "warn" | "bad" | "neutral" {
  if (!backtest) return "neutral";
  if (backtest.verdict === "backtest_sample_available") return "good";
  if (backtest.evaluableSignals > 0) return "warn";
  return "bad";
}

export default function TxlineArenaPage() {
  const [config, setConfig] = useState<TxlineConfig | null>(null);
  const [fixtures, setFixtures] = useState<TxlineFixture[]>([]);
  const [ingestion, setIngestion] = useState<TxlineIngestionStatus | null>(null);
  const [strategyConfig, setStrategyConfig] = useState<TxlineStrategyConfig | null>(null);
  const [liveBacktest, setLiveBacktest] = useState<TxlineBacktest | null>(null);
  const [demoProof, setDemoProof] = useState<TxlineDemoReplayProof | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState("");
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<LoadError | null>(null);

  const [replay, setReplay] = useState<TxlineReplay | null>(null);
  const [proof, setProof] = useState<TxlineSnapshotProof | null>(null);
  const [signals, setSignals] = useState<TxlineStrategySignalsResponse | null>(null);
  const [fixtureLoading, setFixtureLoading] = useState(false);
  const [fixtureError, setFixtureError] = useState<LoadError | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError(null);
    const [
      configResult,
      fixturesResult,
      ingestionResult,
      strategyResult,
      liveBacktestResult,
      demoProofResult,
    ] = await Promise.allSettled([
      fetchTxlineConfig(),
      fetchTxlineFixtures(50),
      fetchTxlineIngestionStatus(),
      fetchTxlineStrategyConfig(),
      fetchTxlineBacktest({ minSampleSize: 20 }),
      fetchTxlineDemoReplayProof(12),
    ]);

    const loadedConfig = settledValue(configResult);
    const loadedFixtures = settledValue(fixturesResult) || [];
    const loadedDemoProof = settledValue(demoProofResult);
    const errors = [
      settledError(configResult),
      settledError(fixturesResult),
      settledError(ingestionResult),
      settledError(strategyResult),
      settledError(liveBacktestResult),
      settledError(demoProofResult),
    ].filter(Boolean);

    setConfig(loadedConfig);
    setFixtures(loadedFixtures);
    setIngestion(settledValue(ingestionResult));
    setStrategyConfig(settledValue(strategyResult));
    setLiveBacktest(settledValue(liveBacktestResult));
    setDemoProof(loadedDemoProof);

    const nextFixtureId =
      loadedDemoProof?.fixtureIds[0] ||
      loadedFixtures[0]?.fixtureId ||
      "";
    setSelectedFixtureId((current) => current || nextFixtureId);

    if (!loadedConfig && loadedFixtures.length === 0 && !loadedDemoProof) {
      setOverviewError({
        title: "TxLINE workbench could not load",
        message: errors[0] || "Start the AIR OTC API and confirm TxLINE routes are mounted.",
      });
    }
    setOverviewLoading(false);
  }, []);

  const loadFixture = useCallback(async (fixtureId: string) => {
    if (!fixtureId) return;
    setFixtureLoading(true);
    setFixtureError(null);
    const [replayResult, signalsResult, proofResult] = await Promise.allSettled([
      fetchTxlineReplay(fixtureId, 500),
      fetchTxlineStrategySignals(fixtureId, 100),
      fetchTxlineSnapshotProof(fixtureId),
    ]);

    const loadedReplay = settledValue(replayResult);
    const loadedSignals = settledValue(signalsResult);
    const loadedProof = settledValue(proofResult);
    setReplay(loadedReplay);
    setSignals(loadedSignals);
    setProof(loadedProof);

    if (!loadedReplay && !loadedSignals && !loadedProof) {
      setFixtureError({
        title: "Fixture proof is unavailable",
        message:
          settledError(replayResult) ||
          settledError(signalsResult) ||
          settledError(proofResult) ||
          "No replay, proof, or signal data exists for this fixture yet.",
      });
    }
    setFixtureLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOverview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedFixtureId) return undefined;
    const timer = window.setTimeout(() => {
      void loadFixture(selectedFixtureId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFixture, selectedFixtureId]);

  const allFixtures = useMemo(() => {
    const byId = new Map<string, TxlineFixture>();
    for (const fixture of fixtures) byId.set(fixture.fixtureId, fixture);
    for (const fixtureId of demoProof?.fixtureIds || []) {
      if (!byId.has(fixtureId)) {
        byId.set(fixtureId, {
          fixtureId,
          sport: "football",
          status: "demo_replay",
          homeTeam: fixtureId.replace("demo-replay-worldcup-", "Demo "),
          awayTeam: "Replay",
        });
      }
    }
    return [...byId.values()];
  }, [demoProof?.fixtureIds, fixtures]);

  const selectedFixture = allFixtures.find((fixture) => fixture.fixtureId === selectedFixtureId) || null;
  const primaryBacktest = demoProof?.backtest || liveBacktest;
  const replayEvents = replay?.events || [];
  const strategySignals = signals?.signals || [];
  const liveProfitReady = Boolean(liveBacktest && liveBacktest.evaluableSignals >= liveBacktest.minSampleSize);
  const demoReady = Boolean(demoProof?.seeded.ready);
  const bridgePreview = strategySignals[0];

  if (overviewLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="h-4 w-40 skeleton" />
            <div className="mt-3 h-10 w-72 max-w-full skeleton" />
          </div>
          <div className="h-10 w-32 skeleton" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SkeletonPanel />
          <SkeletonPanel />
          <SkeletonPanel />
          <SkeletonPanel />
        </div>
      </div>
    );
  }

  if (overviewError) {
    return <ErrorPanel error={overviewError} onRetry={loadOverview} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent">World Cup track</p>
          <h1 className="mt-2 font-headline text-3xl font-semibold tracking-tight text-text-primary md:text-4xl">
            TxLINE Arena
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-text-secondary">
            Live TxLINE fixtures feed the strategy engine; deterministic replay proves settled evaluation when live outcomes are not ready.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill tone={config?.txlineConfigured ? "good" : "bad"}>
            {config?.txlineConfigured ? "TxLINE configured" : "Token missing"}
          </StatusPill>
          <button
            type="button"
            onClick={loadOverview}
            className="inline-flex min-h-10 items-center gap-2 border border-border-subtle bg-bg-elevated px-4 text-sm font-bold text-text-primary transition-colors hover:bg-bg-highest focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden="true">
              refresh
            </span>
            Refresh
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Live TxLINE"
          value={config?.txlineNetwork || "unknown"}
          detail={config?.txlineBaseUrl || "API origin unavailable"}
          icon="dns"
          tone={config?.txlineConfigured ? "good" : "bad"}
        />
        <MetricCard
          label="SSE Ingestion"
          value={ingestion?.running ? "Running" : "Ready"}
          detail={`Streams: ${config?.streamEndpoints?.join(", ") || "not reported"}`}
          icon="podcasts"
          tone={ingestion?.running ? "good" : "neutral"}
        />
        <MetricCard
          label="Replay Proof"
          value={demoReady ? "Settled" : "Needs seed"}
          detail={
            demoReady
              ? `${demoProof?.seeded.fixtures || 0} fixtures, ${demoProof?.seeded.signals || 0} signals, ${demoProof?.seeded.outcomes || 0} outcomes`
              : "Run the admin seed endpoint before the final judge demo."
          }
          icon="replay"
          tone={demoReady ? "good" : "warn"}
        />
        <MetricCard
          label="Backtest Claim"
          value={liveProfitReady ? "Live sample" : "Replay sample"}
          detail={
            primaryBacktest
              ? `${primaryBacktest.evaluableSignals}/${primaryBacktest.totalSignals} evaluable, accuracy ${percent(primaryBacktest.accuracy)}`
              : "No backtest data loaded yet."
          }
          icon="analytics"
          tone={backtestTone(primaryBacktest)}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
        <aside className="space-y-4">
          <section className="border border-border-subtle bg-bg-card p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">Fixtures</h2>
                <p className="mt-1 text-xs text-text-muted">{allFixtures.length} available</p>
              </div>
              <span className="material-symbols-outlined text-accent" aria-hidden="true">
                sports_soccer
              </span>
            </div>
            {allFixtures.length === 0 ? (
              <EmptyPanel
                title="No fixtures stored"
                body="Sync TxLINE fixtures or seed demo replay before showing the judge walkthrough."
              />
            ) : (
              <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                {allFixtures.map((fixture) => {
                  const active = fixture.fixtureId === selectedFixtureId;
                  const isDemo = fixture.fixtureId.startsWith("demo-replay-worldcup-");
                  return (
                    <button
                      key={fixture.fixtureId}
                      type="button"
                      onClick={() => setSelectedFixtureId(fixture.fixtureId)}
                      className={`w-full min-h-16 border px-3 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent ${
                        active
                          ? "border-accent/50 bg-accent-bg"
                          : "border-border-subtle bg-bg-root hover:bg-bg-elevated"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-headline text-sm font-semibold text-text-primary">
                          {fixtureName(fixture)}
                        </p>
                        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-widest ${isDemo ? "text-warning" : "text-accent"}`}>
                          {isDemo ? "replay" : "live"}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-text-muted">
                        {shortId(fixture.fixtureId)} · {fixture.status || "unknown"} · {formatDate(fixture.startsAt)}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </aside>

        <main className="space-y-6">
          <section className="border border-border-subtle bg-bg-card p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="font-headline text-xl font-semibold">
                  {selectedFixture ? fixtureName(selectedFixture) : "Fixture proof"}
                </h2>
                <p className="mt-2 font-mono text-xs text-text-muted">{selectedFixtureId || "No fixture selected"}</p>
              </div>
              {selectedFixtureId ? (
                <a
                  href={getTxlineReplayStreamUrl(selectedFixtureId)}
                  className="inline-flex min-h-10 items-center gap-2 border border-border-subtle bg-bg-elevated px-4 text-sm font-bold text-text-primary transition-colors hover:bg-bg-highest focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">
                    stream
                  </span>
                  Replay SSE
                </a>
              ) : null}
            </div>

            {fixtureLoading ? (
              <div className="mt-5">
                <SkeletonPanel />
              </div>
            ) : fixtureError ? (
              <div className="mt-5">
                <ErrorPanel error={fixtureError} onRetry={() => loadFixture(selectedFixtureId)} />
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
                <div className="border border-border-subtle bg-bg-root p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-text-muted">Replay events</p>
                  <p className="mt-2 font-mono text-2xl text-text-primary">{replay?.count || 0}</p>
                </div>
                <div className="border border-border-subtle bg-bg-root p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-text-muted">Odds snapshots</p>
                  <p className="mt-2 font-mono text-2xl text-text-primary">{proof?.acceptance.oddsSnapshots || 0}</p>
                </div>
                <div className="border border-border-subtle bg-bg-root p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-text-muted">Score snapshots</p>
                  <p className="mt-2 font-mono text-2xl text-text-primary">{proof?.acceptance.scoreSnapshots || 0}</p>
                </div>
                <div className="border border-border-subtle bg-bg-root p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-text-muted">Signals</p>
                  <p className="mt-2 font-mono text-2xl text-text-primary">{signals?.count || 0}</p>
                </div>
              </div>
            )}
          </section>

          <section className="border border-border-subtle bg-bg-card p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">Deterministic Timeline</h2>
                <p className="mt-1 text-xs text-text-muted">Ordered by TxLINE timestamp, event type, source update, then ID.</p>
              </div>
              <StatusPill tone={replay?.deterministic ? "good" : "neutral"}>
                {replay?.deterministic ? "deterministic" : "waiting"}
              </StatusPill>
            </div>
            {replayEvents.length === 0 ? (
              <EmptyPanel
                title="No replay events for this fixture"
                body="Run snapshot sync or demo replay seed, then refresh this page."
              />
            ) : (
              <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                {replayEvents.slice(0, 80).map((event) => (
                  <div key={event.id} className="grid gap-3 border border-border-subtle bg-bg-root p-3 md:grid-cols-[72px_minmax(0,1fr)_140px] md:items-center">
                    <div className="font-mono text-xs text-text-muted">#{event.sequence}</div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={event.type === "odds" ? "good" : "neutral"}>{event.type}</StatusPill>
                        <p className="truncate text-sm font-semibold text-text-primary">{eventHeadline(event)}</p>
                      </div>
                      <p className="mt-2 truncate text-xs text-text-muted">{eventDetail(event)}</p>
                    </div>
                    <p className="font-mono text-xs text-text-muted md:text-right">{formatDate(event.txlineTimestamp)}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="border border-border-subtle bg-bg-card p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">Strategy Signals</h2>
                <p className="mt-1 text-xs text-text-muted">{strategyConfig?.strategy || "sharp_movement_v1"} emits signal-only trade intent.</p>
              </div>
              <StatusPill tone={strategySignals.length > 0 ? "good" : "neutral"}>
                {strategySignals.length} signals
              </StatusPill>
            </div>
            {strategySignals.length === 0 ? (
              <EmptyPanel
                title="No strategy signals"
                body="This fixture has no qualifying odds movement yet, or strategy has not been run for it."
              />
            ) : (
              <div className="space-y-2">
                {strategySignals.slice(0, 8).map((signal) => (
                  <div key={signal.id} className="border border-border-subtle bg-bg-root p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <p className="font-headline text-sm font-semibold text-text-primary">
                          {signal.direction} · {signal.selection || "selection"}
                        </p>
                        <p className="mt-2 text-xs leading-5 text-text-secondary">{signal.reason || "Deterministic movement signal."}</p>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-right md:min-w-64">
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-text-muted">Before</p>
                          <p className="font-mono text-sm">{numberLabel(signal.oddsBefore, 3)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-text-muted">After</p>
                          <p className="font-mono text-sm">{numberLabel(signal.oddsAfter, 3)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-widest text-text-muted">Conf</p>
                          <p className="font-mono text-sm">{percent(signal.confidence)}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="space-y-6">
          <section className="border border-border-subtle bg-bg-card p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">Judge Proof</h2>
                <p className="mt-1 text-xs text-text-muted">Live ingestion and replay evaluation are separated.</p>
              </div>
              <StatusPill tone={backtestTone(primaryBacktest)}>{primaryBacktest?.verdict || "no proof"}</StatusPill>
            </div>
            {primaryBacktest ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">Accuracy</p>
                    <p className="mt-2 font-mono text-xl text-text-primary">{percent(primaryBacktest.accuracy)}</p>
                  </div>
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">1u PnL</p>
                    <p className="mt-2 font-mono text-xl text-text-primary">{numberLabel(primaryBacktest.oneUnitPnl)}</p>
                  </div>
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">Evaluable</p>
                    <p className="mt-2 font-mono text-xl text-text-primary">{primaryBacktest.evaluableSignals}</p>
                  </div>
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">Outcomes</p>
                    <p className="mt-2 font-mono text-xl text-text-primary">{primaryBacktest.storedOutcomes}</p>
                  </div>
                </div>
                {primaryBacktest.sampleSizeWarning ? (
                  <div className="border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
                    {primaryBacktest.sampleSizeWarning}
                  </div>
                ) : null}
                {demoProof ? (
                  <p className="text-xs leading-5 text-text-muted">{demoProof.judgeNote}</p>
                ) : null}
              </div>
            ) : (
              <EmptyPanel title="No backtest loaded" body="Refresh after the API is online and the proof route is available." />
            )}
          </section>

          <section className="border border-border-subtle bg-bg-card p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">AIR OTC Bridge</h2>
                <p className="mt-1 text-xs text-text-muted">Signals convert into NONE-mode escrow offers with wallet auth.</p>
              </div>
              <span className="material-symbols-outlined text-accent" aria-hidden="true">
                account_tree
              </span>
            </div>
            {bridgePreview ? (
              <div className="space-y-3">
                <div className="border border-border-subtle bg-bg-root p-3">
                  <p className="text-[10px] uppercase tracking-widest text-text-muted">Asset</p>
                  <p className="mt-2 break-all font-mono text-xs text-text-primary">
                    TXLINE:{bridgePreview.fixtureId}:{bridgePreview.marketType || "market"}:{bridgePreview.selection || "selection"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">Rollup</p>
                    <p className="mt-2 font-mono text-sm text-text-primary">NONE</p>
                  </div>
                  <div className="border border-border-subtle bg-bg-root p-3">
                    <p className="text-[10px] uppercase tracking-widest text-text-muted">Signal</p>
                    <p className="mt-2 font-mono text-sm text-text-primary">{shortId(bridgePreview.id)}</p>
                  </div>
                </div>
                <p className="text-xs leading-5 text-text-muted">
                  The browser stays read-only. Offer creation uses POST /v1/txline/strategy/signals/:signalId/offer with Solana wallet authentication.
                </p>
              </div>
            ) : (
              <EmptyPanel
                title="Bridge waits for a signal"
                body="Once a strategy signal exists, this panel shows the exact AIR OTC asset shape for the escrow offer."
              />
            )}
          </section>

          <section className="border border-border-subtle bg-bg-card p-5">
            <h2 className="font-headline text-lg font-semibold">Public API</h2>
            <div className="mt-4 space-y-2">
              {Object.entries(config?.publicEndpoints || {}).slice(0, 8).map(([name, endpoint]) => (
                <div key={name} className="border border-border-subtle bg-bg-root p-3">
                  <p className="text-[10px] uppercase tracking-widest text-text-muted">{name}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-text-secondary">{endpoint}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
