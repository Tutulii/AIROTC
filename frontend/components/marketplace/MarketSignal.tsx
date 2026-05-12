"use client";

import { type Offer } from "@/lib/api";
import { getTokenMetadata } from "@/lib/tokenConfig";

interface MarketSignalProps {
    offers: Offer[];
}

interface Signal {
    type: "info" | "warning" | "success" | "error";
    icon: string;
    title: string;
    detail: string;
}

/**
 * MarketSignal — Live pattern detection from the offer set.
 *
 * Detects:
 * - Liquidity Surge: >5 offers in the set
 * - Spread Compression: tight bid/ask gap
 * - Whale Alert: single offer > 3× average size
 * - Token Dominance: >70% of offers in one token
 * - Imbalanced Book: buy/sell ratio > 3:1 or < 1:3
 */
export function MarketSignal({ offers }: MarketSignalProps) {
    const signals: Signal[] = [];

    if (offers.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-8">
                <span className="material-symbols-outlined text-2xl text-text-disabled mb-2">wifi_tethering_off</span>
                <span className="text-text-muted text-xs font-mono">No signals — awaiting offers</span>
            </div>
        );
    }

    // ── Liquidity Surge ──
    if (offers.length >= 5) {
        signals.push({
            type: "info",
            icon: "water_drop",
            title: "Liquidity Active",
            detail: `${offers.length} live offers on the book`,
        });
    }

    // ── Whale Alert ──
    const avgSize = offers.reduce((s, o) => s + o.amount * o.price, 0) / offers.length;
    const whales = offers.filter((o) => o.amount * o.price > avgSize * 3);
    if (whales.length > 0) {
        signals.push({
            type: "warning",
            icon: "priority_high",
            title: "Whale Alert",
            detail: `${whales.length} offer(s) exceed 3× avg size ($${avgSize.toFixed(0)})`,
        });
    }

    // ── Token Dominance ──
    const tokenCounts = new Map<string, number>();
    for (const o of offers) {
        const mint = o.tokenMint || "SOL";
        tokenCounts.set(mint, (tokenCounts.get(mint) || 0) + 1);
    }
    for (const [mint, count] of tokenCounts.entries()) {
        if (count / offers.length >= 0.7 && offers.length >= 3) {
            const t = getTokenMetadata(mint === "SOL" ? undefined : mint);
            signals.push({
                type: "info",
                icon: "token",
                title: `${t.symbol} Dominant`,
                detail: `${Math.round((count / offers.length) * 100)}% of offers are ${t.symbol}`,
            });
        }
    }

    // ── Spread Compression ──
    const buyPrices = offers.filter((o) => o.mode === "buy").map((o) => o.price);
    const sellPrices = offers.filter((o) => o.mode === "sell").map((o) => o.price);
    if (buyPrices.length > 0 && sellPrices.length > 0) {
        const bestBid = Math.max(...buyPrices);
        const bestAsk = Math.min(...sellPrices);
        const spreadPct = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 0;
        if (spreadPct > 0 && spreadPct < 2) {
            signals.push({
                type: "success",
                icon: "compress",
                title: "Tight Spread",
                detail: `Bid/Ask spread: ${spreadPct.toFixed(2)}%`,
            });
        } else if (spreadPct > 10) {
            signals.push({
                type: "warning",
                icon: "expand",
                title: "Wide Spread",
                detail: `Bid/Ask gap: ${spreadPct.toFixed(1)}% — low competition`,
            });
        }
    }

    // ── Imbalanced Book ──
    const buys = offers.filter((o) => o.mode === "buy").length;
    const sells = offers.filter((o) => o.mode === "sell").length;
    if (buys > 0 && sells > 0) {
        const ratio = buys / sells;
        if (ratio > 3) {
            signals.push({
                type: "warning",
                icon: "trending_up",
                title: "Buyer Pressure",
                detail: `${buys}:${sells} buy/sell ratio — demand exceeds supply`,
            });
        } else if (ratio < 0.33) {
            signals.push({
                type: "warning",
                icon: "trending_down",
                title: "Seller Pressure",
                detail: `${buys}:${sells} buy/sell ratio — supply exceeds demand`,
            });
        }
    }

    if (signals.length === 0) {
        signals.push({
            type: "info",
            icon: "check_circle",
            title: "Market Stable",
            detail: "No anomalies detected in the current offer set",
        });
    }

    const iconColor: Record<Signal["type"], string> = {
        info: "text-accent",
        warning: "text-warning",
        success: "text-success",
        error: "text-error",
    };

    const bgColor: Record<Signal["type"], string> = {
        info: "bg-accent/5 border-accent/10",
        warning: "bg-warning/5 border-warning/10",
        success: "bg-success/5 border-success/10",
        error: "bg-error/5 border-error/10",
    };

    return (
        <div className="space-y-2">
            {signals.map((s, i) => (
                <div
                    key={i}
                    className={`flex items-start gap-3 p-3 border ${bgColor[s.type]} transition-all hover:translate-x-1`}
                >
                    <span className={`material-symbols-outlined text-lg mt-0.5 ${iconColor[s.type]}`}>
                        {s.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                        <div className={`text-xs font-bold ${iconColor[s.type]}`}>{s.title}</div>
                        <div className="text-[10px] text-text-muted mt-0.5 truncate">{s.detail}</div>
                    </div>
                </div>
            ))}
        </div>
    );
}
