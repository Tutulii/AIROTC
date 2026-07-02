"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { useState, useEffect } from "react";
import { fetchHealth } from "@/lib/api";

const MAX_POINTS = 12;
const POLL_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2500;

type PulsePoint = { time: string; activity: number };

function timeLabel(date = new Date()): string {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function fetchHealthWithTimeout(): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    await fetchHealth({ signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Market Pulse — shows platform activity over time.
 * Currently tracks real-time connection activity (not mock volume data).
 * Each poll records a data point so the chart builds up organically.
 */
export function MarketPulse() {
  const [dataPoints, setDataPoints] = useState<PulsePoint[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const label = timeLabel();

      try {
        const start = performance.now();
        await fetchHealthWithTimeout();
        if (cancelled) return;
        const latency = Math.round(performance.now() - start);
        setConnected(true);

        setDataPoints((prev) => {
          const next = [...prev, { time: label, activity: latency }];
          return next.slice(-MAX_POINTS);
        });
      } catch {
        if (cancelled) return;
        setConnected(false);
        setDataPoints((prev) => {
          const next = [...prev, { time: label, activity: 0 }];
          return next.slice(-MAX_POINTS);
        });
      }
    };

    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="lg:col-span-2 bg-bg-card-hover p-6 relative overflow-hidden group animate-fade-in-up">
      <div className="flex justify-between items-center mb-6 relative z-10">
        <div>
          <h3 className="font-headline font-semibold text-lg">Market Pulse</h3>
          <span className="text-[10px] font-mono text-text-muted">
            {connected ? "Live API latency (ms)" : "Disconnected — no data"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-accent animate-pulse" : "bg-error"}`}></span>
          <span className="text-[10px] font-mono text-text-muted">
            {connected ? "LIVE" : "OFFLINE"}
          </span>
        </div>
      </div>

      <div className="h-64 relative">
        {dataPoints.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-6 h-6 border-2 border-accent/50 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
              <span className="text-text-muted text-xs font-mono">Checking API heartbeat...</span>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dataPoints}>
              <defs>
                <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#46f1c5" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#46f1c5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "#64748B", fontFamily: "JetBrains Mono" }}
                interval={1}
              />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  background: "#1d2026",
                  border: "1px solid #2A3042",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontFamily: "JetBrains Mono",
                  color: "#e1e2eb",
                }}
                labelStyle={{ color: "#64748B" }}
                formatter={(value) => [`${value}ms`, "Latency"]}
              />
              <Area
                type="monotone"
                dataKey="activity"
                stroke="#46f1c5"
                strokeWidth={2}
                fill="url(#chartGradient)"
                dot={dataPoints.length < 3 ? { r: 3, fill: "#46f1c5", strokeWidth: 0 } : false}
                activeDot={{ r: 4, fill: "#46f1c5", stroke: "#11151c", strokeWidth: 2 }}
                animationDuration={450}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
