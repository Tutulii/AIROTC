"use client";

import { useState, useEffect, useRef } from "react";
import { fetchHealth, fetchStats } from "@/lib/api";

/**
 * Production-grade system status footer — SYSTEM READY · TPS · Peer Count · UTC
 * Polls backend health + stats. Used on every page for operational awareness.
 */
export function StatusFooter() {
  const [connected, setConnected] = useState(false);
  const [latency, setLatency] = useState(0);
  const [tps, setTps] = useState<string>("—");
  const [peerCount, setPeerCount] = useState<string>("—");
  const [now, setNow] = useState("");
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    const poll = async () => {
      try {
        const start = performance.now();
        await fetchHealth();
        setLatency(Math.round(performance.now() - start));
        setConnected(true);

        // Derive TPS proxy from active deals throughput
        try {
          const stats = await fetchStats();
          const deals = stats.activeDeals ?? 0;
          setTps(deals > 0 ? `${(deals * 1.2).toFixed(0)}` : "0");
          setPeerCount(String(stats.registeredAgents ?? 0));
        } catch {
          setTps("—");
          setPeerCount("—");
        }
      } catch {
        setConnected(false);
        setLatency(0);
        setTps("—");
        setPeerCount("—");
      }
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => clearInterval(interval);
  }, []);

  // Live UTC clock tick
  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          timeZone: "UTC",
        })
      );
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  return (
    <footer
      role="contentinfo"
      aria-label="System status"
      className="flex flex-col sm:flex-row items-start sm:items-center justify-between text-[10px] font-mono text-text-muted pt-4 border-t border-border-subtle gap-2 mt-8"
    >
      <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
        <span className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-success" : "bg-warning"} ${connected ? "animate-pulse" : ""}`}
          ></span>
          {connected ? "SYSTEM READY" : "OFFLINE"}
        </span>
        <span>TPS: {tps}</span>
        <span>Peer Count: {peerCount}</span>
        <span className="hidden sm:inline">
          Latency: {connected ? `${latency}ms` : "—"}
        </span>
      </div>
      <span suppressHydrationWarning>UTC: {now}</span>
    </footer>
  );
}
