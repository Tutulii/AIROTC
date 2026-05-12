/**
 * RPC Health Tracker — Solana Connection Observability
 *
 * Wraps Solana RPC calls with latency + error tracking:
 * - Per-method tracking (getBalance, sendTransaction, etc.)
 * - Rolling 5-minute window for avg latency / error rate
 * - Expose via GET /v1/health/rpc
 */

import { logger } from "../utils/logger";

// ==========================================
// TYPES
// ==========================================

interface MethodMetrics {
    totalCalls: number;
    totalErrors: number;
    latencies: { ts: number; ms: number }[];
}

export interface RpcHealthSnapshot {
    overall: {
        totalCalls: number;
        totalErrors: number;
        errorRate: number;
        avgLatencyMs: number;
    };
    methods: Record<string, {
        calls: number;
        errors: number;
        errorRate: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
    }>;
    windowSizeMs: number;
}

// ==========================================
// TRACKER ENGINE
// ==========================================

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

class RpcHealthTracker {
    private methods: Map<string, MethodMetrics> = new Map();

    /**
     * Record a successful RPC call.
     */
    recordCall(method: string, latencyMs: number): void {
        const m = this.getOrCreate(method);
        m.totalCalls++;
        m.latencies.push({ ts: Date.now(), ms: latencyMs });
        this.prune(m);
    }

    /**
     * Record a failed RPC call.
     */
    recordError(method: string, latencyMs: number): void {
        const m = this.getOrCreate(method);
        m.totalCalls++;
        m.totalErrors++;
        m.latencies.push({ ts: Date.now(), ms: latencyMs });
        this.prune(m);
    }

    /**
     * Wrap an async RPC call with automatic tracking.
     */
    async track<T>(method: string, fn: () => Promise<T>): Promise<T> {
        const start = performance.now();
        try {
            const result = await fn();
            this.recordCall(method, performance.now() - start);
            return result;
        } catch (e) {
            this.recordError(method, performance.now() - start);
            throw e;
        }
    }

    /**
     * Get a full health snapshot.
     */
    getSnapshot(): RpcHealthSnapshot {
        let totalCalls = 0;
        let totalErrors = 0;
        let allLatencies: number[] = [];
        const methodSnapshots: RpcHealthSnapshot["methods"] = {};

        for (const [name, m] of this.methods.entries()) {
            this.prune(m);
            const windowLatencies = m.latencies.map((l) => l.ms);
            const errors = m.totalErrors;
            const calls = m.totalCalls;

            totalCalls += calls;
            totalErrors += errors;
            allLatencies = allLatencies.concat(windowLatencies);

            const avgMs = windowLatencies.length > 0
                ? Math.round(windowLatencies.reduce((a, b) => a + b, 0) / windowLatencies.length)
                : 0;

            const sorted = [...windowLatencies].sort((a, b) => a - b);
            const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

            methodSnapshots[name] = {
                calls,
                errors,
                errorRate: calls > 0 ? Math.round((errors / calls) * 10000) / 100 : 0,
                avgLatencyMs: avgMs,
                p95LatencyMs: Math.round(p95),
            };
        }

        const overallAvg = allLatencies.length > 0
            ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)
            : 0;

        return {
            overall: {
                totalCalls,
                totalErrors,
                errorRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 10000) / 100 : 0,
                avgLatencyMs: overallAvg,
            },
            methods: methodSnapshots,
            windowSizeMs: WINDOW_MS,
        };
    }

    private getOrCreate(method: string): MethodMetrics {
        if (!this.methods.has(method)) {
            this.methods.set(method, { totalCalls: 0, totalErrors: 0, latencies: [] });
        }
        return this.methods.get(method)!;
    }

    private prune(m: MethodMetrics): void {
        const cutoff = Date.now() - WINDOW_MS;
        m.latencies = m.latencies.filter((l) => l.ts >= cutoff);
    }
}

export const rpcHealthTracker = new RpcHealthTracker();
