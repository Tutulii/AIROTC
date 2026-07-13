import type {
  SportFixtureSummary,
  TxlineFixture,
  TxlineReplay,
  TxlineReplayEvent,
} from "./api";
import { resolveCountry } from "./flags";

export const PRIMARY_MARKET = "1X2_PARTICIPANT_RESULT";
export const SELECTION_ORDER = ["part1", "draw", "part2"] as const;
export type SelectionKey = (typeof SELECTION_ORDER)[number];

export type OddsQuote = {
  market: string;
  selection: string;
  odds: number;
  probabilityPct: number;
  timestamp: string;
  source: "summary" | "replay";
};

export type MarketBoard = {
  market: string;
  quotes: OddsQuote[];
  series: OddsQuote[];
  selections: string[];
  lastTimestamp: string | null;
};

export type LiveScore = {
  homeScore: number | null;
  awayScore: number | null;
  status: string;
  timestamp: string | null;
  clockLabel: string | null;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)[key], source);
}

function firstNumber(source: Record<string, unknown>, paths: string[]): number | null {
  for (const path of paths) {
    const value = path.includes(".") ? readPath(source, path) : source[path];
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function scoreFromRecord(
  source: Record<string, unknown>
): Pick<LiveScore, "homeScore" | "awayScore"> {
  const stats = asRecord(
    source.Stats ||
      source.stats ||
      readPath(source, "Data.New.Stats") ||
      readPath(source, "Data.Stats")
  );
  const homeScore =
    firstNumber(source, [
      "homeScore",
      "home_score",
      "Score.Participant1.Total.Goals",
      "Data.New.Score.Participant1.Total.Goals",
      "Data.Score.Participant1.Total.Goals",
      "normalizedScoreState.homeScore",
    ]) ?? firstNumber(stats, ["1"]);
  const awayScore =
    firstNumber(source, [
      "awayScore",
      "away_score",
      "Score.Participant2.Total.Goals",
      "Data.New.Score.Participant2.Total.Goals",
      "Data.Score.Participant2.Total.Goals",
      "normalizedScoreState.awayScore",
    ]) ?? firstNumber(stats, ["2"]);
  return { homeScore, awayScore };
}

export function teamCode(name?: string | null): string {
  const resolved = resolveCountry(name);
  if (resolved?.code) return resolved.code;
  const clean = (name || "TBD").replace(/[^a-zA-Z]/g, "").toUpperCase();
  return clean.slice(0, 3).padEnd(3, "T");
}

export function teamName(
  summary: SportFixtureSummary | null,
  fixture: TxlineFixture | null,
  side: "part1" | "part2"
): string {
  if (side === "part1") {
    return summary?.teams?.home || summary?.teams?.part1 || fixture?.homeTeam || "Home";
  }
  return summary?.teams?.away || summary?.teams?.part2 || fixture?.awayTeam || "Away";
}

export function shortWallet(wallet?: string | null, chars = 4): string {
  if (!wallet) return "—";
  if (wallet.length <= chars * 2 + 2) return wallet;
  return `${wallet.slice(0, chars)}…${wallet.slice(-chars)}`;
}

export function formatSol(value?: number | null, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} SOL`;
}

export function formatAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatKickoff(iso?: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBD";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeSelection(raw?: string | null): string {
  const s = (raw || "").toLowerCase().trim();
  if (!s) return "";
  if (s === "1" || s === "home" || s === "part1" || s === "p1" || s.includes("participant1"))
    return "part1";
  if (s === "x" || s === "draw" || s === "tie" || s === "x2") return "draw";
  if (s === "2" || s === "away" || s === "part2" || s === "p2" || s.includes("participant2"))
    return "part2";
  return s;
}

export function selectionLabel(
  selection: string,
  home: string,
  away: string
): string {
  const n = normalizeSelection(selection);
  if (n === "part1") return home;
  if (n === "part2") return away;
  if (n === "draw") return "Draw";
  return selection;
}

export function selectionTone(selection: string): "home" | "draw" | "away" {
  const n = normalizeSelection(selection);
  if (n === "part1") return "home";
  if (n === "part2") return "away";
  return "draw";
}

function isFullMatch1x2(market?: string | null): boolean {
  if (!market) return false;
  const m = market.toUpperCase();
  if (m.includes("HALF") && (m.includes("=1") || m.includes("HALF_1") || m.includes("1ST"))) {
    return false;
  }
  return (
    m.includes("1X2") ||
    m === PRIMARY_MARKET ||
    m.includes("PARTICIPANT_RESULT") ||
    m.includes("MATCH_RESULT")
  );
}

function extractOddsFromRaw(raw: Record<string, unknown>): number | null {
  return (
    toNumber(raw.oddsValue) ??
    toNumber(raw.odds) ??
    toNumber(raw.Odds) ??
    toNumber(raw.price) ??
    toNumber(raw.Price) ??
    toNumber(readPath(raw, "Data.Odds")) ??
    toNumber(readPath(raw, "Data.New.Odds"))
  );
}

function extractSelectionFromRaw(raw: Record<string, unknown>): string {
  const direct =
    (raw.selection as string) ||
    (raw.Selection as string) ||
    (raw.outcome as string) ||
    (raw.Outcome as string) ||
    "";
  if (direct) return normalizeSelection(direct);
  const name = String(raw.name || raw.Name || raw.participant || "").toLowerCase();
  return normalizeSelection(name);
}

function extractMarketFromRaw(raw: Record<string, unknown>): string {
  return String(
    raw.marketType ||
      raw.market ||
      raw.MarketType ||
      raw.Market ||
      readPath(raw, "Data.MarketType") ||
      PRIMARY_MARKET
  );
}

function extractTimestamp(raw: Record<string, unknown>, fallback?: string): string {
  const t =
    (raw.timestamp as string) ||
    (raw.txlineTimestamp as string) ||
    (raw.Timestamp as string) ||
    (raw.updatedAt as string) ||
    fallback ||
    new Date().toISOString();
  return t;
}

function quoteFromOddsRecord(
  raw: Record<string, unknown>,
  source: "summary" | "replay",
  fallbackTs?: string
): OddsQuote | null {
  const market = extractMarketFromRaw(raw);
  if (!isFullMatch1x2(market) && source === "summary") {
    // Still accept if market missing but has clear 1X2 selection
    const sel = extractSelectionFromRaw(raw);
    if (!SELECTION_ORDER.includes(sel as SelectionKey)) return null;
  } else if (!isFullMatch1x2(market) && source === "replay") {
    return null;
  }

  const odds = extractOddsFromRaw(raw);
  const selection = extractSelectionFromRaw(raw);
  if (odds == null || odds <= 1 || !selection) return null;
  if (!SELECTION_ORDER.includes(selection as SelectionKey) && selection !== "over" && selection !== "under") {
    // keep only 1X2 for board
    if (!["part1", "draw", "part2"].includes(selection)) return null;
  }

  const probabilityPct = odds > 0 ? (1 / odds) * 100 : 0;
  return {
    market: isFullMatch1x2(market) ? PRIMARY_MARKET : market,
    selection,
    odds,
    probabilityPct,
    timestamp: extractTimestamp(raw, fallbackTs),
    source,
  };
}

export function pickMarket(
  summary: SportFixtureSummary | null,
  replay: TxlineReplay | null
): MarketBoard | null {
  const series: OddsQuote[] = [];

  // Prefer full-match 1X2 from summary latestOdds
  for (const item of summary?.latestOdds || []) {
    const q = quoteFromOddsRecord(asRecord(item), "summary");
    if (q && SELECTION_ORDER.includes(q.selection as SelectionKey)) {
      series.push(q);
    }
  }

  // Replay history for chart/series
  for (const ev of replay?.events || []) {
    if (ev.type !== "odds" && !ev.oddsValue) continue;
    const raw = {
      ...asRecord(ev.raw),
      marketType: ev.marketType,
      selection: ev.selection,
      oddsValue: ev.oddsValue,
      txlineTimestamp: ev.txlineTimestamp,
    };
    const q = quoteFromOddsRecord(raw, "replay", ev.txlineTimestamp);
    if (q && SELECTION_ORDER.includes(q.selection as SelectionKey)) {
      series.push(q);
    }
  }

  if (!series.length) return null;

  // Latest quote per selection
  const latestBySel = new Map<string, OddsQuote>();
  const sorted = [...series].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  for (const q of sorted) {
    latestBySel.set(q.selection, q);
  }

  const quotes = SELECTION_ORDER.map((s) => latestBySel.get(s)).filter(
    (q): q is OddsQuote => Boolean(q)
  );

  if (!quotes.length) return null;

  const lastTimestamp =
    quotes.reduce<string | null>((acc, q) => {
      if (!acc) return q.timestamp;
      return new Date(q.timestamp) > new Date(acc) ? q.timestamp : acc;
    }, null) || null;

  return {
    market: PRIMARY_MARKET,
    quotes,
    series: sorted,
    selections: quotes.map((q) => q.selection),
    lastTimestamp,
  };
}

export function pickLiveScore(
  summary: SportFixtureSummary | null,
  replay: TxlineReplay | null
): LiveScore {
  let homeScore = summary?.latestScore?.homeScore ?? null;
  let awayScore = summary?.latestScore?.awayScore ?? null;
  const status = summary?.latestScore?.status || summary?.status || "unknown";
  let timestamp = summary?.latestScore?.timestamp || null;
  const clockLabel = summary?.latestScore?.label || null;

  // Walk score events for freshest
  const scoreEvents = (replay?.events || []).filter(
    (e) => e.type === "score" || e.scoreState
  );
  for (const ev of scoreEvents) {
    const fromState = scoreFromRecord(asRecord(ev.scoreState));
    const fromRaw = scoreFromRecord(asRecord(ev.raw));
    if (fromState.homeScore != null) homeScore = fromState.homeScore;
    if (fromState.awayScore != null) awayScore = fromState.awayScore;
    if (fromRaw.homeScore != null) homeScore = fromRaw.homeScore;
    if (fromRaw.awayScore != null) awayScore = fromRaw.awayScore;
    timestamp = ev.txlineTimestamp || timestamp;
  }

  return { homeScore, awayScore, status, timestamp, clockLabel };
}

/** Same window as main AIR OTC sport page — matches past this are history/final. */
export const ASSUMED_LIVE_WINDOW_MS = 4 * 60 * 60 * 1_000;

export type DerivedFixtureStatus = "live" | "upcoming" | "final" | "unknown";

export function isLiveStatus(status?: string | null): boolean {
  const s = (status || "").toLowerCase();
  return (
    s.includes("live") ||
    s.includes("inplay") ||
    s.includes("in_play") ||
    s.includes("started") ||
    s.includes("1h") ||
    s.includes("2h") ||
    s.includes("ht") ||
    s === "playing"
  );
}

export function isSettledStatus(status?: string | null, result?: { settled?: boolean } | null): boolean {
  if (result?.settled) return true;
  const s = (status || "").toLowerCase();
  return (
    s.includes("settled") ||
    s.includes("finished") ||
    s.includes("ended") ||
    s === "ft" ||
    s === "final" ||
    s === "complete" ||
    s === "completed"
  );
}

export function fixtureSortKey(f: TxlineFixture): number {
  const t = f.startsAt ? new Date(f.startsAt).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function mergedStatusText(source: Record<string, unknown>): string {
  return [
    source.status,
    source.Status,
    source.GameStatus,
    source.GameState,
    source.GameStateName,
    source.state,
    source.action,
    source.Action,
    source.period,
    source.Period,
    source.phase,
    source.Phase,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(" ")
    .toLowerCase();
}

/**
 * Derive score-level status from TxLINE score payload (same rules as main sport page).
 */
export function scoreStatusFromRecord(source: Record<string, unknown>): string | null {
  const rawStatus = String(source.status || source.GameState || source.state || "").toLowerCase();
  const action = String(source.action || source.Action || "").toLowerCase();
  const statusText = mergedStatusText(source);
  const clock = asRecord(source.clock || source.Clock);

  if (
    ["final", "finished", "complete", "completed", "3", "4"].includes(rawStatus) ||
    action.includes("final")
  ) {
    return "final";
  }

  if (
    ["live", "in_play", "in_progress", "running", "started", "2"].includes(rawStatus) ||
    /(live|in[-_\s]?play|in[-_\s]?progress|running|started)/i.test(statusText) ||
    clock.Running === true ||
    typeof clock.Seconds === "number"
  ) {
    return "live";
  }

  return rawStatus || null;
}

/**
 * Match status used by main AIR OTC sport desk.
 *
 * Critical: kickoff older than ASSUMED_LIVE_WINDOW wins over a stuck API `live`
 * flag (TxLINE often leaves status=live after full time). Same data; main UI
 * puts those fixtures in History as FINAL.
 */
export function fixtureDerivedStatus(
  fixture: TxlineFixture | null,
  nowMs: number = Date.now()
): DerivedFixtureStatus {
  if (!fixture) return "unknown";

  const startsAt = new Date(fixture.startsAt || 0).getTime();

  // Age-out first — same membership rule as main historyFixtureList
  if (Number.isFinite(startsAt) && startsAt > 0 && nowMs - startsAt > ASSUMED_LIVE_WINDOW_MS) {
    return "final";
  }

  const raw = asRecord(fixture.raw);
  const latestScoreState = asRecord(raw.latestScoreState);
  const scoreStatus = scoreStatusFromRecord(latestScoreState);
  if (scoreStatus === "final") return "final";
  if (scoreStatus === "live") {
    // Only trust live score-state inside the live window
    if (!Number.isFinite(startsAt) || startsAt <= 0 || nowMs - startsAt <= ASSUMED_LIVE_WINDOW_MS) {
      return "live";
    }
    return "final";
  }

  const status = (fixture.status || "unknown").toLowerCase();
  if (status === "final" || isSettledStatus(status)) return "final";

  if (status === "live" || isLiveStatus(status)) {
    if (Number.isFinite(startsAt) && startsAt > 0 && nowMs - startsAt > ASSUMED_LIVE_WINDOW_MS) {
      return "final";
    }
    if (Number.isFinite(startsAt) && startsAt > nowMs + 15 * 60 * 1_000) {
      // Far-future kickoff with stale live label → treat as upcoming
      return "upcoming";
    }
    return "live";
  }

  if (Number.isFinite(startsAt) && startsAt > 0) {
    if (startsAt <= nowMs && nowMs - startsAt <= ASSUMED_LIVE_WINDOW_MS) return "live";
    if (startsAt > nowMs) return "upcoming";
    return "final";
  }

  if (status === "upcoming") return "upcoming";
  return "unknown";
}

/** List bucket for filters — maps final → settled for existing UI labels. */
export function classifyFixture(
  f: TxlineFixture,
  resultSettled?: boolean,
  nowMs: number = Date.now()
): "live" | "upcoming" | "settled" {
  if (resultSettled) return "settled";
  const derived = fixtureDerivedStatus(f, nowMs);
  if (derived === "live") return "live";
  if (derived === "upcoming") return "upcoming";
  return "settled";
}

/**
 * Match hero status: prefer explicit final/settled, then fixture-derived
 * (so stuck summary.status=live cannot override age-out).
 */
export function matchDisplayStatus(
  fixture: TxlineFixture | null,
  summary: SportFixtureSummary | null,
  scoreStatus: string | null | undefined,
  nowMs: number = Date.now()
): DerivedFixtureStatus {
  if (summary?.result?.settled) return "final";
  if (isSettledStatus(scoreStatus) || scoreStatus === "final") return "final";

  const derived = fixtureDerivedStatus(fixture, nowMs);
  if (derived === "final") return "final";
  if (derived === "live") return "live";
  if (derived === "upcoming") return "upcoming";

  if (isLiveStatus(scoreStatus) || isLiveStatus(summary?.status)) {
    // Last resort: only live if still inside window
    const startsAt = fixture?.startsAt ? new Date(fixture.startsAt).getTime() : NaN;
    if (Number.isFinite(startsAt) && nowMs - startsAt > ASSUMED_LIVE_WINDOW_MS) return "final";
    return "live";
  }

  return derived;
}

export function oddsSeriesForSelection(
  board: MarketBoard | null,
  selection: string
): { t: number; odds: number }[] {
  if (!board) return [];
  return board.series
    .filter((q) => q.selection === selection)
    .map((q) => ({ t: new Date(q.timestamp).getTime(), odds: q.odds }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.odds));
}

export function latestOddsDelta(
  board: MarketBoard | null,
  selection: string
): number | null {
  const pts = oddsSeriesForSelection(board, selection);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2].odds;
  const b = pts[pts.length - 1].odds;
  if (!a) return null;
  return ((b - a) / a) * 100;
}

/** Tiny sparkline path for odds history */
export function sparklinePath(
  points: { odds: number }[],
  width = 72,
  height = 28
): string {
  if (points.length < 2) return "";
  const vals = points.map((p) => p.odds);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((p.odds - min) / range) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function scoreEventsFromReplay(replay: TxlineReplay | null): TxlineReplayEvent[] {
  return (replay?.events || []).filter((e) => e.type === "score" || e.scoreState);
}
