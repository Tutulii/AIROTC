"use client";

import { motion, AnimatePresence, useReducedMotion, type Variants } from "framer-motion";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { fetchRecentDeals, fetchHealth, type RecentDeal } from "@/lib/api";
import { isCancelledDealStatus, isCompletedDealStatus, isFailedDealStatus } from "@/lib/dealStatus";

type EventType = "success" | "warning" | "error" | "info";

const dotColors: Record<EventType, string> = {
  success: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]",
  warning: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
  error: "bg-rose-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]",
  info: "bg-blue-400 shadow-[0_0_8px_rgba(59,130,246,0.5)]",
};

interface EventItem {
  id: string;
  type: EventType;
  message: string;
  time: string;
  agent: string;
}

function dealToEvent(deal: RecentDeal, index: number): EventItem {
  const wallet = deal.buyer.slice(0, 6) + "..." + deal.buyer.slice(-4);
  const asset = deal.offer?.asset || "Unknown";
  const ago = Math.round((Date.now() - new Date(deal.createdAt).getTime()) / 60000);
  const timeLabel = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;

  let type: EventType = "warning";
  let message = `negotiating ${asset} deal.`;

  if (isCompletedDealStatus(deal.status)) {
    type = "success";
    message = `completed ${asset} deal.`;
  } else if (isCancelledDealStatus(deal.status) || isFailedDealStatus(deal.status)) {
    type = "error";
    message = `${deal.status} ${asset} deal.`;
  }

  return { id: `${deal.id}-${index}`, type, message, time: timeLabel, agent: wallet };
}

const slideInRight: Variants = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
};

const staticVariant: Variants = {
  initial: { opacity: 1, x: 0 },
  animate: { opacity: 1, x: 0 },
};

export function EventStream() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [connected, setConnected] = useState(false);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        setConnected(true);
        const deals = await fetchRecentDeals(6);
        const mapped = deals.map(dealToEvent);
        setEvents(mapped);
        // Track IDs so the next poll can animate only NEW items
        prevIdsRef.current = new Set(mapped.map((e) => e.id));
      } catch {
        setConnected(false);
        setEvents([]);
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="bg-bg-card-hover p-6 flex flex-col"
      role="log"
      aria-label="Live event stream"
      aria-live="polite"
    >
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-headline font-semibold text-lg">Event Stream</h3>
        <span className="text-[10px] font-mono text-text-muted flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-accent animate-pulse" : "bg-error"}`}
          />
          {connected ? "Live" : "Offline"}
        </span>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto max-h-[300px] custom-scrollbar pr-2">
        {events.length === 0 ? (
          <div className="text-center py-8">
            <span className="text-text-disabled text-xs font-mono">
              {connected ? "No recent activity" : "Backend offline"}
            </span>
          </div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            {events.map((event) => (
              <motion.div
                key={event.id}
                className="flex items-start gap-3 group"
                variants={reducedMotion ? staticVariant : slideInRight}
                initial="initial"
                animate="animate"
                exit="exit"
                layout={!reducedMotion}
                whileHover={reducedMotion ? {} : { x: 4 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              >
                <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dotColors[event.type]}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-secondary leading-snug">
                    <span className="text-accent-dim font-medium">{event.agent}</span>{" "}
                    {event.message}
                  </p>
                  <span className="text-[10px] font-mono text-text-disabled">
                    {event.time}
                  </span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      <Link
        href="/explorer"
        className="mt-6 text-center text-xs font-bold text-accent hover:underline uppercase tracking-widest block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card-hover"
      >
        View All Deals →
      </Link>
    </div>
  );
}
