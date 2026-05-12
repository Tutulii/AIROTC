"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchHealth, fetchOffers, fetchStats, type HealthStatus, type Offer } from "@/lib/api";

// ─── Generic hook for data fetching with loading/error/retry ───

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): UseApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

// ─── Health Check ───

export function useHealth(pollInterval = 30000) {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const check = () => {
      fetchHealth()
        .then((h) => {
          setHealth(h);
          setConnected(true);
        })
        .catch(() => setConnected(false));
    };

    check();
    const interval = setInterval(check, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval]);

  return { health, connected };
}

// ─── Offers ───

export function useOffers() {
  return useApi(() => fetchOffers());
}

// ─── Dashboard Stats ───
// These aggregate data from multiple endpoints

export interface DashboardStats {
  activeDeals: number;
  volume24h: string;
  settlementRate: string;
  registeredAgents: number;
}

export function useDashboardStats() {
  const [stats, setStats] = useState<DashboardStats>({
    activeDeals: 0,
    volume24h: "$0",
    settlementRate: "0%",
    registeredAgents: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const fetchApiStats = async () => {
      try {
        await fetchHealth();
        setConnected(true);

        const realStats = await fetchStats();
        setStats(realStats);
      } catch {
        setConnected(false);
        setStats({
          activeDeals: 0,
          volume24h: "$0",
          settlementRate: "0%",
          registeredAgents: 0,
        });
        setError("Backend offline — live data unavailable.");
      } finally {
        setLoading(false);
      }
    };

    fetchApiStats();
    const interval = setInterval(fetchApiStats, 15000); // Poll every 15s
    return () => clearInterval(interval);
  }, []);

  return { stats, loading, error, connected };
}
