"use client";

import { useMemo, useState } from "react";
import {
  selectionLabel,
  teamCode,
  type MarketBoard,
  type OddsQuote,
} from "@/lib/sport-utils";
import { GoalFlashOverlay, type GoalFlash } from "@/components/GoalFlashOverlay";

export type ChartRange = "live" | "1h" | "1d" | "1w" | "1m";

const RANGE_MS: Record<ChartRange, number> = {
  live: 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

const RANGE_LABELS: { id: ChartRange; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "1h", label: "1h" },
  { id: "1d", label: "1d" },
  { id: "1w", label: "1w" },
  { id: "1m", label: "1m" },
];

/** On The Line series — orange / muted / blue */
const SERIES_COLORS: Record<string, string> = {
  part1: "#d97a1e", // orange — home
  draw: "#585a5b", // muted gray — draw
  part2: "#2e6fbe", // blue — away
};

const DRAW_ORDER = ["part1", "draw", "part2"];

type ChartSample = { t: number; pct: number };

function quoteTime(quote: OddsQuote): number {
  const parsed = new Date(quote.timestamp || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAxisTime(value: number, range: ChartRange): string {
  if (!Number.isFinite(value) || value <= 0) return "--:--";
  const d = new Date(value);
  if (range === "1d" || range === "1w" || range === "1m") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatVolumeLabel(sol: number | null | undefined): string {
  if (sol == null || !Number.isFinite(sol) || sol <= 0) return "Open interest —";
  if (sol >= 1000) return `Open interest ${sol.toFixed(1)} SOL`;
  if (sol >= 1) return `Open interest ${sol.toFixed(3)} SOL`;
  return `Open interest ${sol.toFixed(4)} SOL`;
}

function buildStepSeries(
  points: OddsQuote[],
  startTime: number,
  endTime: number
): ChartSample[] {
  const sorted = [...points]
    .map((point) => ({ t: quoteTime(point), pct: point.probabilityPct }))
    .filter((sample) => sample.t > 0 && Number.isFinite(sample.pct))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) return [];

  let currentPct = sorted[0].pct;
  for (const sample of sorted) {
    if (sample.t <= startTime) currentPct = sample.pct;
    else break;
  }

  const series: ChartSample[] = [{ t: startTime, pct: currentPct }];
  for (const sample of sorted) {
    if (sample.t < startTime) continue;
    if (sample.t > endTime) break;
    series.push({ t: sample.t, pct: currentPct });
    currentPct = sample.pct;
    series.push({ t: sample.t, pct: currentPct });
  }
  series.push({ t: endTime, pct: currentPct });
  return series;
}

function chartPathFromSamples(
  samples: ChartSample[],
  width: number,
  min: number,
  max: number,
  startTime: number,
  endTime: number,
  topPad: number,
  plotHeight: number
): string {
  if (samples.length === 0) return "";
  const span = max - min || 1;
  const timeSpan = Math.max(endTime - startTime, 1);
  const yOf = (pct: number) => topPad + (plotHeight - ((pct - min) / span) * plotHeight);
  const xOf = (t: number) =>
    Math.min(width, Math.max(0, ((t - startTime) / timeSpan) * width));

  return samples
    .map((sample, index) => {
      const x = xOf(sample.t);
      const y = yOf(sample.pct);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function seriesLabel(selection: string, home: string, away: string): string {
  if (selection === "part1") return home.split(/\s+/)[0] || teamCode(home);
  if (selection === "part2") return away.split(/\s+/)[0] || teamCode(away);
  if (selection === "draw") return "Draw";
  return selectionLabel(selection, home, away);
}

export function AdiOddsChart({
  board,
  home,
  away,
  nowMs,
  openInterestSol,
  goalFlash = null,
  onPreviewGoal,
}: {
  board: MarketBoard | null;
  home: string;
  away: string;
  nowMs: number;
  openInterestSol?: number | null;
  /** When set, plays kick→goal overlay on the odds plot (live score increase). */
  goalFlash?: GoalFlash | null;
  /** Optional: preview animation for review (home/away). */
  onPreviewGoal?: (side: "home" | "away") => void;
}) {
  const [range, setRange] = useState<ChartRange>("live");

  const width = 1000;
  const height = 300;
  const leftPad = 8;
  const rightPad = 120;
  const topPad = 18;
  const bottomPad = 32;
  const plotEndX = width - rightPad;
  const plotWidth = plotEndX - leftPad;
  const plotHeight = height - topPad - bottomPad;

  const chartModel = useMemo(() => {
    const preferredWindowMs = RANGE_MS[range];
    const visibleSeries = (board?.series || []).slice(-800);
    const times = visibleSeries
      .map(quoteTime)
      .filter((time) => time > 0)
      .sort((a, b) => a - b);
    const rawEndTime = Math.max(times[times.length - 1] || nowMs, nowMs);
    const axisEndTime = rawEndTime;
    const axisStartTime = axisEndTime - preferredWindowMs;
    const axisTicks = [0, 0.25, 0.5, 0.75, 1].map(
      (ratio) => axisStartTime + (axisEndTime - axisStartTime) * ratio
    );

    const latestBySelection = new Map<string, number>();
    for (const selection of board?.selections || DRAW_ORDER) {
      const points = visibleSeries.filter((point) => point.selection === selection);
      const last = points[points.length - 1];
      if (last) latestBySelection.set(selection, last.probabilityPct);
    }
    for (const q of board?.quotes || []) {
      if (!latestBySelection.has(q.selection)) {
        latestBySelection.set(q.selection, q.probabilityPct);
      }
    }

    const latestValues = [...latestBySelection.values()];
    const dataMin = latestValues.length ? Math.min(...latestValues) : 20;
    const dataMax = latestValues.length ? Math.max(...latestValues) : 55;
    let min = Math.max(0, Math.min(15, dataMin - 6));
    let max = Math.min(100, Math.max(56, dataMax + 6));
    if (max - min < 30) {
      const mid = (max + min) / 2;
      min = Math.max(0, mid - 15);
      max = Math.min(100, mid + 15);
    }
    const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => min + (max - min) * (1 - ratio));
    const span = max - min || 1;

    const yOf = (pct: number) => topPad + ((max - pct) / span) * plotHeight;
    const xOf = (t: number) =>
      leftPad + ((t - axisStartTime) / Math.max(axisEndTime - axisStartTime, 1)) * plotWidth;

    const MIN_GAP_PX = 16;
    const byScreenY = [...latestBySelection.entries()]
      .map(([selection, pct]) => ({ selection, pct, y: yOf(pct) }))
      .sort((a, b) => a.y - b.y);
    const adjustedY = byScreenY.map((item) => item.y);
    for (let i = 1; i < adjustedY.length; i += 1) {
      if (adjustedY[i] - adjustedY[i - 1] < MIN_GAP_PX) {
        adjustedY[i] = adjustedY[i - 1] + MIN_GAP_PX;
      }
    }
    if (adjustedY.length && adjustedY[adjustedY.length - 1] > topPad + plotHeight - 6) {
      const overflow = adjustedY[adjustedY.length - 1] - (topPad + plotHeight - 6);
      for (let i = 0; i < adjustedY.length; i += 1) adjustedY[i] -= overflow;
    }
    if (adjustedY.length && adjustedY[0] < topPad + 6) {
      const underflow = topPad + 6 - adjustedY[0];
      for (let i = 0; i < adjustedY.length; i += 1) adjustedY[i] += underflow;
    }
    const displayY = new Map<string, number>();
    byScreenY.forEach((item, i) => displayY.set(item.selection, adjustedY[i]));

    const displayPctOffset = new Map<string, number>();
    for (const [selection, truePct] of latestBySelection) {
      const trueY = yOf(truePct);
      const shownY = displayY.get(selection) ?? trueY;
      const dy = shownY - trueY;
      displayPctOffset.set(selection, (-dy * span) / plotHeight);
    }

    const selections =
      board?.selections?.length
        ? board.selections
        : DRAW_ORDER.filter((s) => latestBySelection.has(s));

    const plottedSelections = selections.flatMap((selection) => {
      let points = visibleSeries.filter((point) => point.selection === selection);
      if (points.length === 0) {
        const q = board?.quotes.find((item) => item.selection === selection);
        if (q) points = [q];
      }
      if (points.length === 0) return [];
      const offset = displayPctOffset.get(selection) || 0;
      const samples = buildStepSeries(points, axisStartTime, axisEndTime).map((sample) => ({
        t: sample.t,
        pct: sample.pct + offset,
      }));
      const path = chartPathFromSamples(
        samples,
        plotWidth,
        min,
        max,
        axisStartTime,
        axisEndTime,
        topPad,
        plotHeight
      );
      const shiftedPath = path.replace(
        /([ML])\s*([-\d.]+)/g,
        (_, cmd: string, x: string) => `${cmd} ${(Number(x) + leftPad).toFixed(2)}`
      );
      const last = points[points.length - 1];
      if (!shiftedPath || !last) return [];
      return [
        {
          selection,
          path: shiftedPath,
          y: displayY.get(selection) ?? yOf(last.probabilityPct),
          truePct: last.probabilityPct,
        },
      ];
    });

    const labelPositions = new Map<string, number>();
    const labelSorted = [...plottedSelections].sort((a, b) => a.y - b.y);
    const labelYs = labelSorted.map((item) => item.y);
    for (let i = 1; i < labelYs.length; i += 1) {
      if (labelYs[i] - labelYs[i - 1] < 28) labelYs[i] = labelYs[i - 1] + 28;
    }
    labelSorted.forEach((item, i) => {
      labelPositions.set(
        item.selection,
        Math.min(topPad + plotHeight - 10, Math.max(topPad + 10, labelYs[i]))
      );
    });

    return {
      plottedSelections,
      labelPositions,
      grid,
      yOf,
      xOf,
      axisTicks,
    };
  }, [board, nowMs, range, plotHeight, plotWidth]);

  return (
    <div className="chart-shell overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5">
        <div className="font-mono text-[0.7rem] text-[var(--text-3)]">
          {formatVolumeLabel(openInterestSol)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onPreviewGoal && (
            <div className="flex items-center gap-1 border-r border-[var(--line)] pr-2">
              <button
                type="button"
                className="btn-ghost !min-h-8 !px-2 !text-[0.62rem]"
                onClick={() => onPreviewGoal("home")}
                disabled={Boolean(goalFlash)}
                title={`Preview goal — ${home}`}
              >
                Preview {teamCode(home)}
              </button>
              <button
                type="button"
                className="btn-ghost !min-h-8 !px-2 !text-[0.62rem]"
                onClick={() => onPreviewGoal("away")}
                disabled={Boolean(goalFlash)}
                title={`Preview goal — ${away}`}
              >
                Preview {teamCode(away)}
              </button>
            </div>
          )}
          <div className="flex items-center gap-0" role="tablist" aria-label="Chart range">
            {RANGE_LABELS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={range === id}
                onClick={() => setRange(id)}
                className={`tab ${range === id ? "is-on" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative px-1 py-1 md:px-2">
        {!board || chartModel.plottedSelections.length === 0 ? (
          <div className="relative flex h-64 items-center justify-center overflow-hidden text-center">
            {goalFlash ? (
              <GoalFlashOverlay flash={goalFlash} home={home} away={away} />
            ) : null}
            {!goalFlash && (
              <div>
                <p className="font-display text-lg text-[var(--text)]">Collecting odds</p>
                <p className="mt-1.5 text-[0.75rem] text-[var(--text-3)]">
                  Full-match 1X2 will plot as TxLINE updates arrive.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="relative h-[16rem] overflow-hidden md:h-[18.5rem]">
            {goalFlash ? (
              <GoalFlashOverlay flash={goalFlash} home={home} away={away} />
            ) : null}
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="h-full w-full"
              role="img"
              aria-label="1X2 implied probability chart"
            >
              {chartModel.grid.map((value) => {
                const y = chartModel.yOf(value);
                return (
                  <g key={value}>
                    <line
                      x1={leftPad}
                      x2={plotEndX}
                      y1={y}
                      y2={y}
                      stroke="rgba(88,90,91,0.35)"
                      strokeDasharray="2 10"
                    />
                    <text
                      x={width - 10}
                      y={y + 4}
                      textAnchor="end"
                      fill="rgba(88,90,91,0.85)"
                      fontSize="11"
                      fontFamily="var(--font-mono), ui-monospace, monospace"
                    >
                      {Math.round(value)}%
                    </text>
                  </g>
                );
              })}

              {[...chartModel.plottedSelections]
                .sort(
                  (a, b) =>
                    DRAW_ORDER.indexOf(a.selection) - DRAW_ORDER.indexOf(b.selection)
                )
                .map(({ selection, path, y, truePct }) => {
                  const labelY = chartModel.labelPositions.get(selection) ?? y;
                  const label = seriesLabel(selection, home, away);
                  const color = SERIES_COLORS[selection] || "#585a5b";
                  return (
                    <g key={selection}>
                      <path
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d={path}
                        className="adi-odds-flow-line"
                        fill="none"
                        stroke={color}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        pathLength={1000}
                        strokeDasharray="76 924"
                        strokeDashoffset="1000"
                        style={{
                          animationDelay: `${Math.max(0, DRAW_ORDER.indexOf(selection)) * 0.22}s`,
                        }}
                        aria-hidden
                      />
                      <circle
                        className="adi-odds-endpoint-pulse"
                        cx={plotEndX}
                        cy={y}
                        r="14"
                        fill={color}
                        opacity="0.1"
                      />
                      <circle cx={plotEndX} cy={y} r="4" fill={color} />
                      <text
                        x={plotEndX + 12}
                        y={labelY - 3}
                        fill={color}
                        fontSize="12"
                        fontWeight="500"
                        fontFamily="var(--font-mono), ui-monospace, monospace"
                      >
                        {label}
                      </text>
                      <text
                        x={plotEndX + 12}
                        y={labelY + 13}
                        fill={color}
                        fontSize="15"
                        fontWeight="500"
                        fontFamily="var(--font-mono), ui-monospace, monospace"
                      >
                        {`${Math.round(truePct)}%`}
                      </text>
                    </g>
                  );
                })}

              {chartModel.axisTicks.map((t, index) => {
                const x = chartModel.xOf(t);
                const anchor =
                  index === 0
                    ? "start"
                    : index === chartModel.axisTicks.length - 1
                      ? "end"
                      : "middle";
                return (
                  <text
                    key={t}
                    x={x}
                    y={height - 8}
                    textAnchor={anchor}
                    fill="rgba(88,90,91,0.9)"
                    fontSize="10"
                    fontFamily="var(--font-mono), ui-monospace, monospace"
                  >
                    {formatAxisTime(t, range)}
                  </text>
                );
              })}
            </svg>
          </div>
        )}
      </div>

      {board && board.quotes.length > 0 && (
        <div className="grid grid-cols-3 border-t border-[var(--line)]">
          {DRAW_ORDER.map((sel) => {
            const q = board.quotes.find((item) => item.selection === sel);
            const color = SERIES_COLORS[sel] || "#585a5b";
            return (
              <div
                key={sel}
                className="border-r border-[var(--line)] px-3 py-3 text-center last:border-r-0"
              >
                <div
                  className="font-mono text-[0.6rem] font-medium uppercase tracking-[0.12em]"
                  style={{ color }}
                >
                  {seriesLabel(sel, home, away)}
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums tracking-tight text-[var(--text)]">
                  {q ? q.odds.toFixed(2) : "—"}
                </div>
                <div className="font-mono text-[0.65rem] text-[var(--text-3)]">
                  {q ? `${q.probabilityPct.toFixed(1)}%` : "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
