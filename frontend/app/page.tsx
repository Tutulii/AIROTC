"use client";

import { useEffect, useState } from "react";
import { EventStream } from "@/components/dashboard/EventStream";
import { MarketPulse } from "@/components/dashboard/MarketPulse";
import { NewRecruits } from "@/components/dashboard/NewRecruits";
import { StatCard } from "@/components/dashboard/StatCard";
import { StatusFooter } from "@/components/layout/StatusFooter";
import { SystemLogs } from "@/components/dashboard/SystemLogs";
import { fetchHealth, fetchRecentDeals, fetchStats, type PlatformStats, type RecentDeal } from "@/lib/api";

function formatVolume(volume: string): string {
  if (volume.startsWith("$")) return volume;
  const numeric = Number(volume);
  if (!Number.isFinite(numeric)) return volume;
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}K`;
  return `$${numeric.toFixed(2)}`;
}

function deriveEventHeadline(deals: RecentDeal[]): string {
  const settled = deals.filter((deal) => ["agreed", "settled", "completed"].includes(deal.status)).length;
  if (settled > 0) return `${settled} recent trades reached terminal settlement.`;
  const active = deals.filter((deal) => !["cancelled", "agreed", "settled", "completed"].includes(deal.status)).length;
  if (active > 0) return `${active} recent tickets are still moving through the pipeline.`;
  return "Observatory is live and waiting for the next on-chain flow.";
}

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [recentDeals, setRecentDeals] = useState<RecentDeal[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        const [statsData, dealsData] = await Promise.all([fetchStats(), fetchRecentDeals(6)]);
        setStats(statsData);
        setRecentDeals(dealsData);
        setConnected(true);
      } catch {
        setConnected(false);
        setStats(null);
        setRecentDeals([]);
      } finally {
        setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="font-mono text-sm text-text-muted">Booting observatory...</span>
        </div>
      </div>
    );
  }

  if (!connected || !stats) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="max-w-md text-center">
          <span className="material-symbols-outlined mb-4 block text-5xl text-warning">cloud_off</span>
          <h2 className="mb-2 font-headline text-xl font-bold">Backend Offline</h2>
          <p className="text-sm text-text-muted">
            Start the AIR OTC API on port 3000 to power the observatory dashboard with real agent, offer,
            and settlement data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <StatCard
          label="Active Deals"
          value={String(stats.activeDeals)}
          change={stats.activeDeals > 0 ? "+Live" : undefined}
          icon="dynamic_form"
          isPrimary
        />

        <div className="lg:col-span-2 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <StatCard label="24H Volume" value={formatVolume(stats.volume24h)} icon="trending_up" />
          <StatCard label="Settlement Rate" value={stats.settlementRate} accentValue />
          <div className="sm:col-span-2 bg-bg-card p-5 border-l border-border-subtle hover:bg-bg-highest transition-all duration-200">
            <span className="text-text-muted text-xs font-medium uppercase">Registered Agents</span>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-2xl font-mono font-medium">{stats.registeredAgents}</span>
              <div className="flex -space-x-2">
                <div className="h-8 w-8 border border-accent/20 bg-accent/10" />
                <div className="h-8 w-8 border border-secondary/20 bg-secondary/10" />
                <div className="h-8 w-8 border border-warning/20 bg-warning/10" />
                <div className="flex h-8 w-8 items-center justify-center border border-border-subtle bg-bg-highest text-[10px] font-mono">
                  +{Math.max(0, Math.min(99, stats.registeredAgents - 3))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MarketPulse />
        <EventStream />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-bg-card p-6">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h3 className="font-headline text-lg font-semibold">Recent Deal Signal</h3>
                <p className="mt-1 text-xs text-text-muted">{deriveEventHeadline(recentDeals)}</p>
              </div>
              <span className="material-symbols-outlined text-3xl text-accent/30">electric_bolt</span>
            </div>
            {recentDeals.length === 0 ? (
              <div className="rounded-lg bg-bg-root p-6 text-center text-xs font-mono text-text-muted">
                No completed or active tickets yet.
              </div>
            ) : (
              <div className="space-y-3">
                {recentDeals.slice(0, 3).map((deal) => (
                  <div
                    key={deal.id}
                    className="flex items-center justify-between bg-bg-root px-4 py-3 transition-colors hover:bg-bg-highest"
                  >
                    <div>
                      <p className="font-headline text-sm font-semibold text-text-primary">
                        {deal.offer?.asset || "Unknown Asset"}
                      </p>
                      <p className="font-mono text-[10px] text-text-muted">
                        {deal.id} · {deal.rollupMode || "ER"} · {new Date(deal.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-widest ${
                        ["agreed", "settled", "completed"].includes(deal.status)
                          ? "text-accent"
                          : deal.status === "cancelled"
                            ? "text-error"
                            : "text-warning"
                      }`}
                    >
                      {deal.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <SystemLogs />
        </div>

        <NewRecruits />
      </div>

      <StatusFooter />
    </div>
  );
}
