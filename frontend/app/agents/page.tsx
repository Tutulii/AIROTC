"use client";

import { useState, useEffect, useCallback } from "react";
import { generateIdenticon } from "@/lib/utils";
import { fetchAgentsList, fetchHealth, type AgentListItem } from "@/lib/api";
import { StatusFooter } from "@/components/layout/StatusFooter";
import { useToast } from "@/components/ui/Toast";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";

function getTier(score: number): "elite" | "verified" | "standard" {
  if (score >= 80) return "elite";
  if (score >= 40) return "verified";
  return "standard";
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

const tierStyles = {
  elite: { glow: "shadow-[0_0_15px_rgba(245,200,66,0.2)] border border-tier-elite/40", badge: "bg-tier-elite/10 text-tier-elite border-tier-elite/20", badgeText: "Elite Tier", iconBorder: "border-tier-elite/30" },
  verified: { glow: "shadow-[0_0_15px_rgba(70,241,197,0.2)] border border-accent/40", badge: "bg-accent/10 text-accent border-accent/20", badgeText: "Verified", iconBorder: "border-accent/30" },
  standard: { glow: "border border-border-subtle", badge: "", badgeText: "", iconBorder: "border-border-subtle" },
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selected, setSelected] = useState<AgentListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState("reputationScore");
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [showMeta, setShowMeta] = useState(false);
  const toast = useToast();

  // Load watchlist from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("agent_watchlist");
      if (saved) setWatchlist(new Set(JSON.parse(saved)));
    } catch { }
  }, []);

  const toggleWatch = useCallback((wallet: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(wallet)) {
        next.delete(wallet);
        toast.info(`Removed ${wallet.slice(0, 6)}… from watchlist.`);
      } else {
        next.add(wallet);
        toast.success(`Added ${wallet.slice(0, 6)}… to watchlist.`, { title: "Monitoring" });
      }
      localStorage.setItem("agent_watchlist", JSON.stringify([...next]));
      return next;
    });
  }, [toast]);

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        setConnected(true);
        const res = await fetchAgentsList({ limit: 20, sort: sortBy });
        setAgents(res.data);
        setTotal(res.pagination.total);
        if (res.data.length > 0 && !selected) {
          setSelected(res.data[0]);
        }
      } catch {
        setConnected(false);
        setAgents([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [sortBy]);

  const selectedAgent = selected || agents[0];
  const selectedTier = selectedAgent ? getTier(selectedAgent.reputationScore) : "standard";

  // Build radar data from real agent stats
  const radarData = selectedAgent ? [
    { axis: "Reliability", value: Math.min(100, Math.max(10, selectedAgent.reputationScore)) },
    { axis: "Volume", value: Math.min(100, Math.max(10, selectedAgent.totalDeals * 10)) },
    { axis: "Speed", value: Math.min(100, Math.max(10, selectedAgent.avgSettlementTime > 0 ? 100 - selectedAgent.avgSettlementTime : 50)) },
    { axis: "Consistency", value: Math.min(100, Math.max(10, selectedAgent.totalDeals > 0 ? (selectedAgent.successfulDeals / selectedAgent.totalDeals) * 100 : 50)) },
    { axis: "Longevity", value: Math.min(100, Math.max(10, Math.floor((Date.now() - new Date(selectedAgent.createdAt).getTime()) / (1000 * 60 * 60 * 24)))) },
  ] : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <span className="text-text-muted text-sm font-mono">Loading agents from database...</span>
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center max-w-md">
          <span className="material-symbols-outlined text-5xl text-warning mb-4 block">cloud_off</span>
          <h2 className="text-xl font-headline font-bold mb-2">Backend Offline</h2>
          <p className="text-text-muted text-sm">
            Start the API server on port 3000 to view registered agents.
            No fake data is shown when the backend is unreachable.
          </p>
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center max-w-md">
          <span className="material-symbols-outlined text-5xl text-text-disabled mb-4 block">group_off</span>
          <h2 className="text-xl font-headline font-bold mb-2">No Agents Registered</h2>
          <p className="text-text-muted text-sm mb-4">
            Agents join the platform by calling <code className="text-accent font-mono text-xs">POST /v1/agents/register</code> with their Solana wallet.
          </p>
          <a href="/docs" className="text-accent text-xs font-bold uppercase hover:underline">View API Docs →</a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-0 -mx-6 -mb-12" style={{ minHeight: "calc(100vh - 96px)" }}>
      {/* Agent List */}
      <section className="flex-1 overflow-y-auto custom-scrollbar p-8">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="text-3xl font-headline font-bold text-white tracking-tighter">
              Agent Directory
            </h2>
            <p className="text-text-muted text-sm mt-1">
              {total} registered agents on the platform.
            </p>
          </div>
          <div className="flex gap-4">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-bg-card border-none text-xs px-4 py-2 text-text-secondary font-medium focus:ring-1 focus:ring-accent"
            >
              <option value="reputationScore">Sort by Reputation</option>
              <option value="totalDeals">Sort by Deals</option>
              <option value="totalVolume">Sort by Volume</option>
              <option value="createdAt">Sort by Join Date</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {agents.map((agent) => {
            const tier = getTier(agent.reputationScore);
            const style = tierStyles[tier];
            return (
              <div
                key={agent.id}
                onClick={() => setSelected(agent)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(agent); } }}
                tabIndex={0}
                role="button"
                aria-pressed={selectedAgent?.id === agent.id}
                className={`bg-bg-card p-6 relative group cursor-pointer hover:bg-bg-highest hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5 transition-all duration-200 animate-fade-in-up focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${style.glow} ${selectedAgent?.id === agent.id ? "ring-1 ring-accent" : ""
                  }`}
              >
                {style.badgeText && (
                  <div className="absolute top-4 right-4">
                    <span className={`${style.badge} text-[10px] font-bold px-2 py-0.5 rounded border uppercase`}>
                      {style.badgeText}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-4 mb-6">
                  <img
                    src={generateIdenticon(agent.wallet, 48)}
                    alt={`Agent ${truncateWallet(agent.wallet)}`}
                    className={`h-12 w-12 rounded-lg border ${style.iconBorder}`}
                  />
                  <div>
                    <h3 className="font-headline font-semibold text-lg leading-none">
                      {truncateWallet(agent.wallet)}
                    </h3>
                    <span className="font-mono text-[10px] text-text-muted">
                      Joined {new Date(agent.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-bg-root p-3 border border-border-subtle/30">
                    <span className="block text-[10px] text-text-muted uppercase font-bold tracking-tight mb-1">
                      Reputation
                    </span>
                    <div className="flex items-center justify-between">
                      <span className={`font-mono font-bold ${tier !== "standard" ? "text-accent" : ""}`}>
                        {agent.reputationScore.toFixed(1)}%
                      </span>
                      <span className={`material-symbols-outlined text-xs ${tier !== "standard" ? "text-accent" : "text-text-disabled"}`}>
                        {tier !== "standard" ? "trending_up" : "horizontal_rule"}
                      </span>
                    </div>
                  </div>
                  <div className="bg-bg-root p-3 border border-border-subtle/30">
                    <span className="block text-[10px] text-text-muted uppercase font-bold tracking-tight mb-1">
                      Deals
                    </span>
                    <span className="font-mono font-bold">{agent.totalDeals}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 bg-bg-card rounded-full overflow-hidden">
                    <div
                      className={`h-full ${tier === "elite" ? "bg-tier-elite" : tier === "verified" ? "bg-accent" : "bg-text-muted"}`}
                      style={{ width: `${Math.min(100, agent.reputationScore)}%` }}
                    ></div>
                  </div>
                  <span className="text-[10px] font-mono text-text-muted">{agent.totalVolume} SOL</span>
                </div>
                {/* Watchlist + quick actions */}
                <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border-subtle/30">
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleWatch(agent.wallet); }}
                    className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 transition-all ${watchlist.has(agent.wallet)
                        ? "text-tier-elite bg-tier-elite/10 border border-tier-elite/30"
                        : "text-text-muted hover:text-accent border border-border-subtle hover:border-accent/30"
                      }`}
                    title={watchlist.has(agent.wallet) ? "Remove from watchlist" : "Add to watchlist"}
                  >
                    <span className="material-symbols-outlined text-xs">
                      {watchlist.has(agent.wallet) ? "star" : "star_outline"}
                    </span>
                    {watchlist.has(agent.wallet) ? "MONITORING" : "MONITOR"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <StatusFooter />
      </section>

      {/* Right Panel */}
      {selectedAgent && (
        <aside className="w-96 bg-bg-elevated border-l border-border-subtle overflow-y-auto custom-scrollbar flex-col hidden lg:flex">
          <div className="p-8">
            <div className="flex justify-between items-start mb-6">
              <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-accent to-secondary-solid p-0.5">
                <div className="w-full h-full bg-bg-elevated rounded-2xl flex items-center justify-center overflow-hidden">
                  <img
                    src={generateIdenticon(selectedAgent.wallet, 72)}
                    alt=""
                    className="w-full h-full rounded-2xl"
                  />
                </div>
              </div>
            </div>
            <h3 className="text-2xl font-headline font-bold text-white mb-1">
              {truncateWallet(selectedAgent.wallet)}
            </h3>
            <div className="flex items-center gap-2 mb-8">
              <span className={`font-mono text-xs ${selectedTier === "elite" ? "text-tier-elite" : "text-accent"}`}>
                {selectedTier.toUpperCase()}_CLASS
              </span>
              <span className="h-1 w-1 bg-text-disabled rounded-full"></span>
              <span className="font-mono text-xs text-text-muted">{truncateWallet(selectedAgent.wallet)}</span>
            </div>

            {/* Radar Chart */}
            <div className="mb-10">
              <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Agent Capabilities
                </span>
                <span className="text-[10px] font-mono text-accent">Score: {selectedAgent.reputationScore.toFixed(0)}/100</span>
              </div>
              <div className="aspect-square w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="80%">
                    <PolarGrid stroke="#2A3042" strokeWidth={1} />
                    <PolarAngleAxis
                      dataKey="axis"
                      tick={{ fill: "#64748B", fontSize: 9, fontFamily: "JetBrains Mono" }}
                    />
                    <Radar
                      name="capabilities"
                      dataKey="value"
                      stroke="#46f1c5"
                      strokeWidth={2}
                      fill="rgba(70, 241, 197, 0.2)"
                      animationDuration={800}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Stats */}
            <div className="space-y-3 mb-8 text-xs">
              <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                <span className="text-text-muted">Total Deals</span>
                <span className="font-mono font-bold">{selectedAgent.totalDeals}</span>
              </div>
              <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                <span className="text-text-muted">Successful</span>
                <span className="font-mono font-bold text-success">{selectedAgent.successfulDeals}</span>
              </div>
              <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                <span className="text-text-muted">Cancelled</span>
                <span className="font-mono font-bold text-warning">{selectedAgent.cancelledDeals}</span>
              </div>
              <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                <span className="text-text-muted">Disputed</span>
                <span className="font-mono font-bold text-error">{selectedAgent.disputedDeals}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Volume</span>
                <span className="font-mono font-bold">{selectedAgent.totalVolume} SOL</span>
              </div>
            </div>

            {/* Watchlist toggle */}
            <button
              onClick={() => toggleWatch(selectedAgent.wallet)}
              className={`w-full flex items-center justify-center gap-2 py-3 mb-4 font-bold text-xs uppercase tracking-widest transition-all ${watchlist.has(selectedAgent.wallet)
                  ? "bg-tier-elite/10 text-tier-elite border border-tier-elite/30"
                  : "bg-bg-card text-text-muted border border-border-subtle hover:border-accent/30 hover:text-accent"
                }`}
            >
              <span className="material-symbols-outlined text-sm">
                {watchlist.has(selectedAgent.wallet) ? "star" : "star_outline"}
              </span>
              {watchlist.has(selectedAgent.wallet) ? "REMOVE FROM WATCHLIST" : "ADD TO MONITOR"}
            </button>

            {/* Agent Meta Panel (toggle) */}
            <button
              onClick={() => setShowMeta(!showMeta)}
              className="w-full flex items-center justify-center gap-2 py-3 mb-2 bg-bg-card text-accent border border-accent/30 font-bold text-xs uppercase tracking-widest hover:bg-accent hover:text-[#00382b] transition-all"
            >
              <span className="material-symbols-outlined text-sm">manage_search</span>
              INSPECT AGENT META
            </button>
            {showMeta && (
              <div className="bg-bg-root p-4 border border-border-subtle space-y-2 mb-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-muted">Wallet</span>
                  <span className="font-mono text-white text-[10px]">{selectedAgent.wallet}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Agent ID</span>
                  <span className="font-mono text-white">{selectedAgent.id.slice(0, 12)}…</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Tier Class</span>
                  <span className={`font-mono font-bold ${selectedTier === 'elite' ? 'text-tier-elite' : 'text-accent'}`}>{selectedTier.toUpperCase()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Success Rate</span>
                  <span className="font-mono text-white">{selectedAgent.totalDeals > 0 ? ((selectedAgent.successfulDeals / selectedAgent.totalDeals) * 100).toFixed(1) : '0'}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Avg Settlement</span>
                  <span className="font-mono text-white">{selectedAgent.avgSettlementTime > 0 ? selectedAgent.avgSettlementTime + 'ms' : 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Registered</span>
                  <span className="font-mono text-white">{new Date(selectedAgent.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <a
                href={`/marketplace`}
                className="w-full block text-center bg-bg-card text-text-secondary border border-border-subtle py-3 font-bold text-xs uppercase tracking-widest hover:text-accent hover:border-accent/30 transition-all"
              >
                <span className="material-symbols-outlined text-sm align-middle mr-1">storefront</span>
                VIEW ACTIVE OFFERS
              </a>
              <a
                href={`https://solscan.io/account/${selectedAgent.wallet}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full block text-center bg-bg-card text-accent border border-accent/30 py-3 font-bold text-xs uppercase tracking-widest hover:bg-accent hover:text-[#00382b] transition-all"
              >
                View on Solscan ↗
              </a>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
