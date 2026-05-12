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

/**
 * Market Pulse — shows platform activity over time.
 * Currently tracks real-time connection activity (not mock volume data).
 * Each poll records a data point so the chart builds up organically.
 */
export function MarketPulse() {
  const [activeRange, setActiveRange] = useState<"LIVE" | "1H" | "24H">("LIVE");
  const [dataPoints, setDataPoints] = useState<{ time: string; activity: number }[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const poll = async () => {
      const now = new Date();
      const timeLabel = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

      try {
        const start = performance.now();
        await fetchHealth();
        const latency = Math.round(performance.now() - start);
        setConnected(true);

        setDataPoints((prev) => {
          const next = [...prev, { time: timeLabel, activity: latency }];
          // Keep last 12 data points
          return next.slice(-12);
        });
      } catch {
        setConnected(false);
        setDataPoints((prev) => {
          const next = [...prev, { time: timeLabel, activity: 0 }];
          return next.slice(-12);
        });
      }
    };

    poll();
    const interval = setInterval(poll, 15000); // Poll every 15s
    return () => clearInterval(interval);
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
        {dataPoints.length < 2 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-6 h-6 border-2 border-accent/50 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
              <span className="text-text-muted text-xs font-mono">Collecting data points...</span>
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
                animationDuration={1200}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
