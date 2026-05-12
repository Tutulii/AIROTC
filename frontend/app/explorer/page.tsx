"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { fetchRecentDeals, fetchHealth, type RecentDeal } from "@/lib/api";
import { StatusFooter } from "@/components/layout/StatusFooter";
import { getTokenMetadata, formatTokenAmount, formatDealValue, computeSpread } from "@/lib/tokenConfig";
import { getDealStatusDotClass, getDealStatusLabel, getDealStatusTextClass } from "@/lib/dealStatus";

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

function solscanLink(address: string): string {
  return `https://solscan.io/account/${address}?cluster=devnet`;
}

export default function ExplorerPage() {
  const [deals, setDeals] = useState<RecentDeal[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<RecentDeal | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        setConnected(true);
        const data = await fetchRecentDeals(50);
        setDeals(data);
        if (data.length > 0) setSelectedDeal(data[0]);
      } catch {
        setConnected(false);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <span className="text-text-muted text-sm font-mono">Loading deals from database...</span>
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
            Start the API server on port 3000 to explore deals.
          </p>
        </div>
      </div>
    );
  }

  if (deals.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center max-w-md">
          <span className="material-symbols-outlined text-5xl text-text-disabled mb-4 block">search_off</span>
          <h2 className="text-xl font-headline font-bold mb-2">No Deals Yet</h2>
          <p className="text-text-muted text-sm mb-4">
            When agents negotiate and create deals, they will appear here with full forensic detail.
          </p>
          <a href="/docs" className="text-accent text-xs font-bold uppercase hover:underline">View API Docs →</a>
        </div>
      </div>
    );
  }

  const deal = selectedDeal || deals[0];

  const statusColor = getDealStatusTextClass(deal.status);
  const statusLabel = getDealStatusLabel(deal.status);
  const dealTermsRedacted = !!deal.offer?.privateTermsRedacted || !!deal.privateTermsRedacted;

  return (
    <>
      {/* Deal List + Detail */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Deal List */}
        <div className="lg:col-span-1 bg-bg-card border border-border-subtle overflow-hidden">
          <div className="px-4 py-3 bg-bg-highest border-b border-border-subtle">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
              Recent Deals ({deals.length})
            </h3>
          </div>
          <div className="divide-y divide-border-subtle/30 max-h-[70vh] overflow-y-auto custom-scrollbar">
            {deals.map((d) => (
              <div
                key={d.id}
                onClick={() => setSelectedDeal(d)}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedDeal(d); }}
                tabIndex={0}
                className={`px-4 py-3 cursor-pointer hover:bg-bg-highest transition-colors ${deal.id === d.id ? "bg-bg-highest border-l-2 border-accent" : ""
                  }`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono text-xs text-white">{d.id.slice(0, 8)}</span>
                  <Link href={`/explorer/${d.id}`} className="text-accent text-[10px] hover:underline ml-2">→</Link>
                  <span className={`text-[10px] font-bold uppercase ${getDealStatusTextClass(d.status)}`}>
                    {getDealStatusLabel(d.status)}
                  </span>
                </div>
                <div className="text-[10px] text-text-muted font-mono mt-1">
                  {d.offer?.asset || "N/A"} · {new Date(d.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Deal Detail */}
        <div className="lg:col-span-3 space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-border-subtle animate-fade-in-up">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <h2 className="text-3xl font-bold font-headline tracking-tight text-white">
                  Deal #{deal.id.slice(0, 8)}
                </h2>
                <div className={`px-3 py-1 bg-accent/10 border border-accent/20 rounded-full flex items-center gap-2`}>
                  <span className={`w-2 h-2 rounded-full ${getDealStatusDotClass(deal.status)}`}></span>
                  <span className={`text-[10px] font-bold ${statusColor} uppercase tracking-widest`}>
                    {statusLabel}
                  </span>
                </div>
              </div>
              {deal.offer && (
                <div className="flex items-center gap-4 font-mono text-lg">
                  <span className="text-text-primary flex items-center gap-1">
                    {(() => {
                      const token = getTokenMetadata(deal.tokenMint);
                      return <>{formatTokenAmount(deal.offer.amount, token.decimals)} <span className="mx-1">{token.icon}</span> {token.symbol}</>;
                    })()}
                  </span>
                  <span className="material-symbols-outlined text-accent">arrow_forward</span>
                  {dealTermsRedacted ? (
                    <span className="text-warning text-sm uppercase tracking-widest">Private PER Terms</span>
                  ) : (
                    <span className="text-secondary">${((deal.offer.price || 0) * deal.offer.amount).toLocaleString()}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Stakeholders */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-fade-in-up">
            <a
              href={solscanLink(deal.buyer)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-4 bg-bg-card-hover border border-secondary/20 flex items-center gap-4 group hover:bg-bg-highest transition-colors"
            >
              <div className="w-12 h-12 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
                <span className="material-symbols-outlined text-2xl">account_balance_wallet</span>
              </div>
              <div className="flex-1">
                <div className="text-[10px] font-bold text-secondary uppercase tracking-tighter">Buyer</div>
                <div className="text-sm font-mono text-white">{truncateWallet(deal.buyer)}</div>
              </div>
              <span className="material-symbols-outlined text-text-disabled group-hover:text-secondary transition-colors">north_east</span>
            </a>
            <a
              href={solscanLink(deal.seller)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-4 bg-bg-card-hover border border-warning/20 flex items-center gap-4 group hover:bg-bg-highest transition-colors"
            >
              <div className="w-12 h-12 rounded-lg bg-warning/10 flex items-center justify-center text-warning">
                <span className="material-symbols-outlined text-2xl">store</span>
              </div>
              <div className="flex-1">
                <div className="text-[10px] font-bold text-warning uppercase tracking-tighter">Seller</div>
                <div className="text-sm font-mono text-white">{truncateWallet(deal.seller)}</div>
              </div>
              <span className="material-symbols-outlined text-text-disabled group-hover:text-warning transition-colors">north_east</span>
            </a>
            <div className="p-4 bg-bg-card-hover border border-accent/20 flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                <span className="material-symbols-outlined text-2xl">verified_user</span>
              </div>
              <div className="flex-1">
                <div className="text-[10px] font-bold text-accent uppercase tracking-tighter">Middleman</div>
                <div className="text-sm font-mono text-white">Protocol Escrow</div>
              </div>
            </div>
          </div>

          {/* Deal Info */}
          <div className="bg-bg-card-hover p-6 border border-border-subtle animate-fade-in-up">
            <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted font-headline mb-6">
              Financial Audit
            </h3>
            {(() => {
              const token = getTokenMetadata(deal.tokenMint);
              const spread = deal.offer && !dealTermsRedacted && deal.offer.price != null
                ? computeSpread(token, deal.offer.collateral || 0, deal.offer.price)
                : null;
              return (
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Deal ID</span>
                    <span className="font-mono text-white">{deal.id}</span>
                  </div>
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Offer ID</span>
                    <span className="font-mono text-white">{deal.offerId}</span>
                  </div>
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Status</span>
                    <span className={`font-mono font-bold ${statusColor}`}>{statusLabel}</span>
                  </div>
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Settlement Token</span>
                    <span className="font-mono text-white flex items-center gap-2">
                      <span className="text-lg">{token.icon}</span>
                      {token.symbol}
                      <span className="text-text-muted text-xs">({token.decimals} decimals)</span>
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Token Mint</span>
                    <span className="font-mono text-white text-xs">{deal.tokenMint || "Native SOL (no mint)"}</span>
                  </div>
                  <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                    <span className="text-text-muted">Quantity</span>
                    <span className="font-mono text-white">
                      {formatTokenAmount(deal.offer?.amount || 0, token.decimals)} {token.symbol}
                    </span>
                  </div>
                  {dealTermsRedacted ? (
                    <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                      <span className="text-text-muted">Terms Visibility</span>
                      <span className="font-mono text-warning">Private PER Terms</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                        <span className="text-text-muted">Unit Price</span>
                        <span className="font-mono text-white">
                          {formatTokenAmount(deal.offer?.price || 0, token.decimals)} {token.symbol}
                        </span>
                      </div>
                      <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                        <span className="text-text-muted">Total Value</span>
                        <span className="font-mono text-accent font-bold">
                          {deal.offer && deal.offer.price != null ? formatDealValue(deal.offer.price, deal.offer.amount) : "N/A"}
                        </span>
                      </div>
                      {deal.offer?.collateral != null && (
                        <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                          <span className="text-text-muted">Collateral Locked</span>
                          <span className="font-mono text-white">
                            {formatTokenAmount(deal.offer.collateral, token.decimals)} {token.symbol}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {spread && (
                    <div className="flex justify-between border-b border-border-subtle/30 pb-2">
                      <span className="text-text-muted">Est. Spread</span>
                      <span className={`font-mono font-bold ${spread.class === 'tight' ? 'text-accent' : spread.class === 'wide' ? 'text-warning' : 'text-text-secondary'
                        }`}>
                        {spread.percent}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-text-muted">Created</span>
                    <span className="font-mono text-white">{new Date(deal.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Links */}
          <div className="flex flex-wrap gap-4 animate-fade-in-up">
            <a
              href={solscanLink(deal.buyer)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-bg-card border border-border-subtle text-xs font-mono text-secondary hover:bg-bg-highest transition-all"
            >
              Buyer on Solscan
              <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            </a>
            <a
              href={solscanLink(deal.seller)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-bg-card border border-border-subtle text-xs font-mono text-warning hover:bg-bg-highest transition-all"
            >
              Seller on Solscan
              <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            </a>
          </div>
        </div>
      </div>
      <StatusFooter />
    </>
  );
}
