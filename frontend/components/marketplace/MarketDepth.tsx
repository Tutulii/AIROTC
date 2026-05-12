"use client";

import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    ResponsiveContainer,
    Tooltip,
    Cell,
    ReferenceLine,
} from "recharts";
import { type Offer } from "@/lib/api";
import { getTokenMetadata, formatTokenAmount } from "@/lib/tokenConfig";

interface MarketDepthProps {
    offers: Offer[];
}

/**
 * MarketDepth — Bid/Ask depth visualization.
 *
 * Groups offers by price tier and renders a horizontal bar chart
 * with bids (buys) in green and asks (sells) in red. Shows cumulative
 * volume at each price level like a real exchange depth chart.
 */
export function MarketDepth({ offers }: MarketDepthProps) {
    if (offers.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12">
                <span className="material-symbols-outlined text-3xl text-text-disabled mb-3">
                    waterfall_chart
                </span>
                <span className="text-text-muted text-xs font-mono">
                    No depth data — awaiting offers
                </span>
            </div>
        );
    }

    // Split into bids (buy) and asks (sell)
    const bids = offers.filter((o) => o.mode === "buy");
    const asks = offers.filter((o) => o.mode === "sell");

    // Create price levels (bucket by nearest integer price)
    const priceLevels = new Map<number, { bidVol: number; askVol: number }>();

    for (const b of bids) {
        const level = Math.round(b.price);
        const entry = priceLevels.get(level) || { bidVol: 0, askVol: 0 };
        entry.bidVol += b.amount * b.price;
        priceLevels.set(level, entry);
    }

    for (const a of asks) {
        const level = Math.round(a.price);
        const entry = priceLevels.get(level) || { bidVol: 0, askVol: 0 };
        entry.askVol += a.amount * a.price;
        priceLevels.set(level, entry);
    }

    // Sort by price and build chart data
    const sortedLevels = Array.from(priceLevels.entries())
        .sort((a, b) => a[0] - b[0]);

    const chartData = sortedLevels.map(([price, { bidVol, askVol }]) => ({
        price: `$${price}`,
        priceNum: price,
        bid: Math.round(bidVol),
        ask: -Math.round(askVol), // negative for left-side rendering
    }));

    // Calculate mid price
    const allPrices = offers.map((o) => o.price).sort((a, b) => a - b);
    const midPrice = allPrices[Math.floor(allPrices.length / 2)] || 0;

    // Summary stats
    const totalBidVol = bids.reduce((s, o) => s + o.amount * o.price, 0);
    const totalAskVol = asks.reduce((s, o) => s + o.amount * o.price, 0);
    const bidAskRatio = totalAskVol > 0 ? totalBidVol / totalAskVol : 0;

    return (
        <div>
            {/* Header Stats */}
            <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="text-center">
                    <div className="text-[10px] font-mono text-success uppercase">Bids</div>
                    <div className="text-sm font-mono font-bold text-success">{bids.length}</div>
                </div>
                <div className="text-center">
                    <div className="text-[10px] font-mono text-text-muted uppercase">Mid</div>
                    <div className="text-sm font-mono font-bold text-white">${midPrice.toFixed(2)}</div>
                </div>
                <div className="text-center">
                    <div className="text-[10px] font-mono text-error uppercase">Asks</div>
                    <div className="text-sm font-mono font-bold text-error">{asks.length}</div>
                </div>
            </div>

            {/* Bid/Ask Ratio Bar */}
            <div className="flex items-center gap-1 mb-4 h-3">
                <div
                    className="h-full bg-success/40 transition-all duration-700"
                    style={{ width: `${Math.min(100, bidAskRatio * 50)}%` }}
                />
                <div
                    className="h-full bg-error/40 transition-all duration-700 flex-1"
                />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-text-muted mb-4">
                <span>Volume: ${totalBidVol.toFixed(0)}</span>
                <span className={bidAskRatio > 1 ? "text-success" : "text-error"}>
                    B/A: {bidAskRatio.toFixed(2)}
                </span>
                <span>Volume: ${totalAskVol.toFixed(0)}</span>
            </div>

            {/* Depth Chart */}
            {chartData.length > 0 && (
                <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} layout="vertical" barCategoryGap="20%">
                            <XAxis type="number" hide />
                            <YAxis
                                type="category"
                                dataKey="price"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 10, fill: "#64748B", fontFamily: "JetBrains Mono" }}
                                width={50}
                            />
                            <Tooltip
                                contentStyle={{
                                    background: "#1d2026",
                                    border: "1px solid #2A3042",
                                    borderRadius: "4px",
                                    fontSize: "11px",
                                    fontFamily: "JetBrains Mono",
                                    color: "#e1e2eb",
                                }}
                                formatter={(value, name) => [
                                    `$${Math.abs(Number(value)).toLocaleString()}`,
                                    name === "bid" ? "Bid Volume" : "Ask Volume",
                                ]}
                            />
                            <Bar dataKey="bid" fill="#22c55e" radius={[0, 4, 4, 0]} animationDuration={800} />
                            <Bar dataKey="ask" fill="#ef4444" radius={[4, 0, 0, 4]} animationDuration={800} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}
