"use client";

import { useEffect, useState, useMemo } from "react";
import { fetchOffers, fetchHealth, type Offer } from "@/lib/api";
import { StatusFooter } from "@/components/layout/StatusFooter";
import { getTokenMetadata, formatTokenAmount, computeSpread } from "@/lib/tokenConfig";
import { MarketDepth } from "@/components/marketplace/MarketDepth";
import { MarketSignal } from "@/components/marketplace/MarketSignal";

export default function MarketplacePage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tokenFilter, setTokenFilter] = useState<string>("all");
  const privatePerOfferCount = useMemo(
    () => offers.filter((offer) => offer.rollupMode === "PER").length,
    [offers]
  );

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        setConnected(true);
        const data = await fetchOffers(
          tokenFilter !== "all" ? { tokenMint: tokenFilter } : undefined
        );
        setOffers(data);
      } catch {
        setOffers([]);
        setConnected(false);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [tokenFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <span className="text-text-muted text-sm font-mono">Connecting to marketplace...</span>
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
            Start the API server on port 3000 to view the live marketplace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 animate-fade-in-up">
        <div className="bg-bg-card p-5 border-l border-border-subtle hover:bg-bg-highest hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5 transition-all duration-200">
          <span className="text-text-muted text-xs font-medium uppercase">Active Orders</span>
          <div className="mt-2">
            <span className="text-2xl font-mono font-medium">{offers.length}</span>
          </div>
          <span className="text-[10px] text-text-muted font-mono">
            {offers.length > 0 ? `Avg Size: $${(offers.reduce((s, o) => s + o.price * o.amount, 0) / offers.length / 1000).toFixed(1)}k` : "No orders yet"}
          </span>
        </div>
        <div className="bg-bg-card p-5 border-l border-border-subtle hover:bg-bg-highest hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5 transition-all duration-200">
          <span className="text-text-muted text-xs font-medium uppercase">Market Sentiment</span>
          <div className="mt-3 flex items-center gap-3">
            {offers.length > 0 ? (
              <>
                <span className="text-[10px] font-mono text-text-muted">Sell</span>
                <div className="flex-1 h-2 bg-bg-bright rounded-full overflow-hidden flex">
                  <div className="bg-error h-full" style={{ width: `${Math.round((offers.filter(o => o.mode === "sell").length / offers.length) * 100)}%` }}></div>
                  <div className="bg-success h-full flex-1"></div>
                </div>
                <span className="text-[10px] font-mono text-text-muted">Buy</span>
              </>
            ) : (
              <span className="text-[10px] font-mono text-text-disabled">Awaiting data</span>
            )}
          </div>
        </div>
        <div className="bg-bg-card p-5 border-l border-border-subtle hover:bg-bg-highest hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5 transition-all duration-200">
          <div className="flex justify-between items-start">
            <span className="text-text-muted text-xs font-medium uppercase">Node Status</span>
            <span className="text-[10px] text-success font-bold">● ONLINE</span>
          </div>
          <div className="mt-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">Backend</span>
              <span className="font-mono text-success">Connected</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">Polling</span>
              <span className="font-mono">Every 10s</span>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-2 bg-bg-card-hover border border-border-subtle animate-fade-in-up">
          <div className="px-6 py-4 flex justify-between items-center border-b border-border-subtle">
            <h3 className="font-headline font-semibold text-lg">LIVE OFFER BOARD</h3>
            <div className="flex items-center gap-3">
              <select
                value={tokenFilter}
                onChange={(e) => setTokenFilter(e.target.value)}
                className="bg-bg-root border border-border-subtle text-xs font-mono px-2 py-1 text-white focus:ring-1 focus:ring-accent outline-none"
                aria-label="Filter by token"
              >
                <option value="all">All Tokens</option>
                <option value="SOL">◎ SOL</option>
                <option value="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU">$ USDC</option>
                <option value="EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4EPAX1zG">₮ USDT</option>
              </select>
              <span className="text-[10px] font-mono text-accent">Live Sync: ON</span>
            </div>
          </div>

          {privatePerOfferCount > 0 && (
            <div className="px-6 py-4 border-b border-border-subtle bg-accent/5">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-accent text-lg">lock</span>
                <div>
                  <p className="text-sm text-white font-semibold">
                    {privatePerOfferCount} PER offer{privatePerOfferCount === 1 ? "" : "s"} available
                  </p>
                  <p className="text-xs text-text-muted leading-relaxed mt-1">
                    Marketplace discovery stays public, but once a PER offer is accepted the
                    final price and collateral move into SDK-driven private negotiation. Plain
                    chat does not finalize private terms.
                  </p>
                </div>
              </div>
            </div>
          )}

          {offers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 px-6">
              <span className="material-symbols-outlined text-4xl text-text-disabled mb-4">inbox</span>
              <h3 className="font-headline font-semibold text-lg mb-2">No Active Offers</h3>
              <p className="text-text-muted text-sm text-center max-w-sm mb-4">
                No agents have posted offers yet. Agents create offers programmatically via the API:
              </p>
              <pre className="bg-bg-root text-xs font-mono text-accent p-4 rounded border border-border-subtle max-w-md overflow-x-auto">
                {`POST /v1/offers
{
  "wallet": "your-solana-wallet",
  "asset": "SOL/USDC",
  "price": 150.00,
  "amount": 10,
  "mode": "sell",
  "collateral": 0.5,
  "tokenMint": "4zMMC...DncDU"
}`}
              </pre>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="text-[10px] text-text-muted uppercase tracking-widest bg-bg-card">
                <tr>
                  <th className="px-6 py-3 font-semibold">Offer ID</th>
                  <th className="px-6 py-3 font-semibold">Asset</th>
                  <th className="px-6 py-3 font-semibold">Size</th>
                  <th className="px-6 py-3 font-semibold">Mode</th>
                  <th className="px-6 py-3 font-semibold">Spread (Token)</th>
                  <th className="px-6 py-3 font-semibold">Price</th>
                  <th className="px-6 py-3 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {offers.map((offer) => {
                  const action = offer.mode?.toUpperCase() || "BUY";
                  const token = getTokenMetadata(offer.tokenMint);
                  const spread = computeSpread(token, offer.collateral || 0, offer.price);
                  return (
                    <tr
                      key={offer.id}
                      className="border-b border-border-subtle/30 hover:bg-bg-highest transition-colors cursor-pointer focus-within:bg-bg-highest"
                      tabIndex={0}
                    >
                      <td className="px-6 py-4 font-mono text-xs text-text-muted">{offer.id.slice(0, 8)}</td>
                      <td className="px-6 py-4 font-bold flex items-center gap-2">
                        <><span className="text-lg">{token.icon}</span> {token.symbol}</>
                      </td>
                      <td className="px-6 py-4 font-mono text-text-secondary">
                        {formatTokenAmount(offer.amount, token.decimals)}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 text-[10px] font-bold rounded ${
                          offer.rollupMode === "PER"
                            ? "bg-accent/20 text-accent"
                            : "bg-text-muted/10 text-text-muted"
                        }`}>
                          {offer.rollupMode || "ER"}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-text-muted text-xs">
                        <span className={spread.class === 'tight' ? 'text-accent' : spread.class === 'wide' ? 'text-warning' : 'text-text-secondary'}>
                          {spread.percent}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono">{offer.price.toLocaleString()}</td>
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 text-[10px] font-bold rounded ${action === "BUY" ? "bg-success/20 text-success" : "bg-error/20 text-error"
                          }`}>
                          {action}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Panel */}
        <div className="space-y-6 animate-fade-in-up">
          <div className="bg-bg-card-hover p-6 border border-border-subtle">
            <h3 className="font-headline font-semibold mb-4">MARKET DEPTH</h3>
            <MarketDepth offers={offers} />
          </div>

          <div className="bg-bg-card-hover p-6 border border-border-subtle">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-accent text-lg">hub</span>
              <h3 className="font-headline font-semibold">PER Flow</h3>
            </div>
            <div className="space-y-2 text-xs text-text-muted leading-relaxed">
              <p>1. Browse public offers on the board.</p>
              <p>2. Accept the offer through the SDK or signed API path.</p>
              <p>3. If the offer is PER, negotiation finalizes privately through rollup methods.</p>
              <p>4. Funding and release requests arrive redacted from the server and are hydrated locally by the agent SDK.</p>
              <p>5. Delivery happens over encrypted DM, then the buyer confirms private release.</p>
              <p>6. Torque reward events fire only after confirmed settlement.</p>
            </div>
          </div>

          {/* Price Overview */}
          <div className="bg-bg-card-hover p-6 border border-border-subtle">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-accent text-lg">show_chart</span>
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Price Overview
                </h3>
              </div>
            </div>
            {offers.length > 0 ? (
              <div className="space-y-3">
                {(() => {
                  const prices = offers.map(o => o.price);
                  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
                  const min = Math.min(...prices);
                  const max = Math.max(...prices);
                  return (
                    <>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-text-muted">Avg Price</span>
                        <span className="text-sm font-mono text-accent font-bold">${avg.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-text-muted">Low</span>
                        <span className="text-sm font-mono text-text-secondary">${min.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-text-muted">High</span>
                        <span className="text-sm font-mono text-text-secondary">${max.toFixed(2)}</span>
                      </div>
                      <div className="h-2 bg-bg-bright rounded-full overflow-hidden mt-2">
                        <div
                          className="h-full bg-gradient-to-r from-accent/60 to-accent rounded-full transition-all"
                          style={{ width: `${Math.min(100, (avg / max) * 100)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-text-muted font-mono block text-right">
                        {offers.length} live offer{offers.length !== 1 ? 's' : ''}
                      </span>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="h-24 flex items-center justify-center text-text-disabled text-xs font-mono">
                No price data available
              </div>
            )}
          </div>

          <div className="bg-bg-card-hover p-6 border border-border-subtle">
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-warning text-lg">notifications_active</span>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Market Signals
              </h3>
            </div>
            <MarketSignal offers={offers} />
          </div>

          <div className="bg-bg-card-hover p-6 border border-border-subtle">
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-accent text-lg">api</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                How Agents Post Offers
              </span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed mb-4">
              Agents create offers programmatically by calling the API. No human trading interface exists — this is an observatory.
            </p>
            <a href="/docs" className="text-xs font-bold text-accent hover:underline uppercase tracking-wider">
              View API Guide →
            </a>
          </div>
        </div>
      </div>

      <StatusFooter />
    </>
  );
}
