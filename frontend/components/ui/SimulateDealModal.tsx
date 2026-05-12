"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

/* ─── Types ─── */

interface SimStep {
    stage: string;
    label: string;
    description: string;
    status: "pending" | "active" | "completed";
    timestamp?: number;
    txSignature?: string;
    details?: Record<string, unknown>;
}

interface SimResult {
    id: string;
    mode: string;
    asset: string;
    amount: number;
    price: number;
    buyer: string;
    seller: string;
    middleman: string;
    steps: SimStep[];
    totalDurationMs: number;
    parties?: Array<{ role: string; wallet: string; contribution: string }>;
}

type SimMode = "standard" | "spl" | "privacy" | "multi-party";

const modeLabels: Record<SimMode, { label: string; desc: string; icon: string }> = {
    standard: { label: "Standard (SOL)", desc: "Native SOL escrow deal", icon: "currency_exchange" },
    spl: { label: "SPL Token", desc: "USDC/USDT token deal", icon: "token" },
    privacy: { label: "Privacy Mode", desc: "Hash-committed terms", icon: "lock" },
    "multi-party": { label: "Multi-Party", desc: "Guarantor + Observer", icon: "groups" },
};

/* ─── Component ─── */

interface SimulateDealModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function SimulateDealModal({ isOpen, onClose }: SimulateDealModalProps) {
    const [mode, setMode] = useState<SimMode>("standard");
    const [phase, setPhase] = useState<"config" | "running" | "done">("config");
    const [steps, setSteps] = useState<SimStep[]>([]);
    const [activeStep, setActiveStep] = useState(0);
    const [simData, setSimData] = useState<SimResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const reducedMotion = useReducedMotion();

    const reset = useCallback(() => {
        setPhase("config");
        setSteps([]);
        setActiveStep(0);
        setSimData(null);
        setError(null);
    }, []);

    const runSimulation = useCallback(async () => {
        setPhase("running");
        setError(null);

        try {
            const res = await fetch(`${API_BASE}/v1/simulate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode, asset: "SOL/USDC", amount: 100, price: 148.5 }),
            });

            if (!res.ok) throw new Error("Simulation API failed");

            const { data } = await res.json();
            setSimData(data);

            // Animate through steps one by one
            const stepsData: SimStep[] = data.steps;
            const allPending = stepsData.map((s: SimStep) => ({ ...s, status: "pending" as const }));
            setSteps(allPending);

            for (let i = 0; i < stepsData.length; i++) {
                await new Promise((r) => setTimeout(r, reducedMotion ? 200 : 800));
                setActiveStep(i);
                setSteps((prev) =>
                    prev.map((s, idx) => ({
                        ...s,
                        status: idx < i ? "completed" : idx === i ? "active" : "pending",
                    }))
                );
            }

            // Mark all complete
            await new Promise((r) => setTimeout(r, reducedMotion ? 200 : 600));
            setSteps((prev) => prev.map((s) => ({ ...s, status: "completed" })));
            setPhase("done");
        } catch {
            setError("Backend offline — start the API server on port 3000 to run simulations.");
            setPhase("config");
        }
    }, [mode, reducedMotion]);

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        if (isOpen) window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <motion.div
                        className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 z-[201] bg-bg-elevated border border-border-subtle shadow-2xl shadow-black/40 overflow-hidden flex flex-col sm:w-[680px] sm:max-h-[85vh]"
                        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 20 }}
                        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 20 }}
                        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Simulate Deal"
                    >
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center shrink-0">
                            <div>
                                <h2 className="text-lg font-headline font-bold text-white">Simulate Deal</h2>
                                <p className="text-[10px] font-mono text-text-muted mt-0.5">
                                    {phase === "config" ? "Configure simulation parameters" : phase === "running" ? "Executing lifecycle…" : "Simulation complete"}
                                </p>
                            </div>
                            <button onClick={onClose} className="text-text-muted hover:text-white transition-colors" aria-label="Close">
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                            {phase === "config" && (
                                <div className="space-y-6">
                                    {/* Mode selector */}
                                    <div>
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-3 block">
                                            Deal Mode
                                        </label>
                                        <div className="grid grid-cols-2 gap-3">
                                            {(Object.entries(modeLabels) as [SimMode, typeof modeLabels[SimMode]][]).map(([key, cfg]) => (
                                                <button
                                                    key={key}
                                                    onClick={() => setMode(key)}
                                                    className={`p-4 text-left border transition-all ${mode === key
                                                            ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                                                            : "border-border-subtle hover:border-text-muted hover:bg-bg-highest"
                                                        }`}
                                                >
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className={`material-symbols-outlined text-base ${mode === key ? "text-accent" : "text-text-disabled"}`}>
                                                            {cfg.icon}
                                                        </span>
                                                        <span className="text-sm font-bold text-white">{cfg.label}</span>
                                                    </div>
                                                    <span className="text-[10px] text-text-muted">{cfg.desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Deal params (read-only preview) */}
                                    <div className="bg-bg-root p-4 border border-border-subtle/50 space-y-2">
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">Deal Parameters</span>
                                        <div className="grid grid-cols-2 gap-3 text-xs mt-2">
                                            <div><span className="text-text-muted">Asset:</span> <span className="font-mono text-white ml-2">SOL/USDC</span></div>
                                            <div><span className="text-text-muted">Amount:</span> <span className="font-mono text-white ml-2">100</span></div>
                                            <div><span className="text-text-muted">Price:</span> <span className="font-mono text-white ml-2">$148.50</span></div>
                                            <div><span className="text-text-muted">Total:</span> <span className="font-mono text-accent font-bold ml-2">$14,850</span></div>
                                        </div>
                                    </div>

                                    {error && (
                                        <div className="bg-error/10 border border-error/20 p-3 text-xs text-error flex items-start gap-2">
                                            <span className="material-symbols-outlined text-sm mt-0.5">error</span>
                                            {error}
                                        </div>
                                    )}
                                </div>
                            )}

                            {(phase === "running" || phase === "done") && (
                                <div className="space-y-1">
                                    {steps.map((step, i) => (
                                        <motion.div
                                            key={step.stage}
                                            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, x: -16 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={{ delay: reducedMotion ? 0 : i * 0.1, duration: 0.3 }}
                                            className={`flex items-start gap-3 p-3 border-l-2 transition-all ${step.status === "completed"
                                                    ? "border-l-emerald-500 bg-emerald-500/5"
                                                    : step.status === "active"
                                                        ? "border-l-accent bg-accent/5"
                                                        : "border-l-border-subtle"
                                                }`}
                                        >
                                            {/* Status icon */}
                                            <div className="mt-0.5 shrink-0">
                                                {step.status === "completed" ? (
                                                    <span className="material-symbols-outlined text-emerald-500 text-base">check_circle</span>
                                                ) : step.status === "active" ? (
                                                    <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                                                ) : (
                                                    <span className="material-symbols-outlined text-text-disabled text-base">radio_button_unchecked</span>
                                                )}
                                            </div>

                                            {/* Content */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-xs font-bold ${step.status === "pending" ? "text-text-disabled" : "text-white"}`}>
                                                        {step.label}
                                                    </span>
                                                    {step.status === "active" && (
                                                        <span className="text-[10px] font-mono text-accent animate-pulse">EXECUTING</span>
                                                    )}
                                                </div>
                                                <p className="text-[11px] text-text-muted mt-0.5 leading-snug">{step.description}</p>
                                                {step.txSignature && step.status === "completed" && (
                                                    <span className="text-[10px] font-mono text-accent-dim mt-1 block truncate">
                                                        TX: {step.txSignature.slice(0, 24)}…
                                                    </span>
                                                )}
                                            </div>
                                        </motion.div>
                                    ))}

                                    {/* Multi-party roster */}
                                    {phase === "done" && simData?.parties && (
                                        <div className="mt-4 p-4 bg-bg-root border border-border-subtle">
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-2 block">
                                                Multi-Party Roster ({simData.parties.length} participants)
                                            </span>
                                            {simData.parties.map((p) => (
                                                <div key={p.role} className="flex justify-between text-xs py-1.5 border-b border-border-subtle/30 last:border-none">
                                                    <span className="font-bold text-white">{p.role}</span>
                                                    <span className="font-mono text-text-muted">{p.contribution}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-border-subtle flex justify-between items-center shrink-0">
                            <span className="text-[10px] font-mono text-text-disabled">
                                {phase === "done" && simData
                                    ? `Simulated in ${(simData.totalDurationMs / 1000).toFixed(1)}s · ${simData.steps?.length ?? 0} steps · ${simData.mode}`
                                    : "No real on-chain transactions"}
                            </span>
                            <div className="flex gap-3">
                                {phase === "done" && (
                                    <button
                                        onClick={reset}
                                        className="px-4 py-2 text-xs font-bold text-text-muted hover:text-white border border-border-subtle hover:border-text-muted transition-all"
                                    >
                                        RUN AGAIN
                                    </button>
                                )}
                                <button
                                    onClick={phase === "config" ? runSimulation : onClose}
                                    disabled={phase === "running"}
                                    className="px-6 py-2 text-xs font-bold bg-accent text-[#00382b] hover:bg-accent/90 transition-all disabled:opacity-50 tracking-wider"
                                >
                                    {phase === "config" ? "LAUNCH SIMULATION" : phase === "running" ? "SIMULATING…" : "CLOSE"}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
