"use client";

import { motion, AnimatePresence, useReducedMotion, type Variants } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { getLogStreamUrl } from "@/lib/api";

interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  ticket_id?: string;
  deal_id?: string;
  severity?: "info" | "warning" | "critical";
  context?: Record<string, unknown>;
}

interface DisplayLog {
  id: string;
  timestamp: string;
  level: "OK" | "INFO" | "WARN" | "ERR";
  message: string;
}

const levelColors: Record<DisplayLog["level"], string> = {
  OK: "text-emerald-500",
  INFO: "text-accent-dim",
  WARN: "text-amber-500",
  ERR: "text-rose-500",
};

function mapLevel(level: LogEntry["level"]): DisplayLog["level"] {
  switch (level) {
    case "debug": return "OK";
    case "info": return "INFO";
    case "warn": return "WARN";
    case "error": return "ERR";
  }
}

function formatMessage(entry: LogEntry): string {
  let msg = entry.event;
  if (entry.ticket_id) msg += ` [${entry.ticket_id}]`;
  if (entry.context?.error_message) msg += ` — ${entry.context.error_message}`;
  return msg;
}

let logIdCounter = 0;

const slideIn: Variants = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -8 },
};

const staticVariant: Variants = {
  initial: { opacity: 1, x: 0 },
  animate: { opacity: 1, x: 0 },
};

export function SystemLogs() {
  const [logs, setLogs] = useState<DisplayLog[]>([]);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const addLog = (level: DisplayLog["level"], message: string) => {
      const now = new Date();
      const timestamp = now.toLocaleTimeString("en-US", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
      const id = `log-${++logIdCounter}-${Date.now()}`;
      setLogs((prev) => [...prev.slice(-50), { id, timestamp, level, message }]);
    };

    addLog("INFO", "Observatory initialized. Connecting to log stream...");

    // SSE connection to real backend log stream
    const streamUrl = getLogStreamUrl();
    const es = new EventSource(streamUrl);

    es.onopen = () => {
      setConnected(true);
      addLog("OK", "Live log stream connected.");
    };

    es.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        const displayLevel = mapLevel(entry.level);
        const message = formatMessage(entry);
        addLog(displayLevel, message);
      } catch {
        // Malformed SSE data — skip
      }
    };

    es.onerror = () => {
      setConnected(false);
      addLog("ERR", "Log stream disconnected. Reconnecting...");
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div
      className="lg:col-span-3 bg-bg-root p-6 border border-border-subtle font-mono text-xs overflow-hidden"
      role="log"
      aria-label="System log stream"
      aria-live="polite"
    >
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full flex items-center justify-center ${connected ? "bg-emerald-500/20" : "bg-rose-500/20"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`}></span>
          </span>
          <span className="text-text-muted font-bold">SYSTEM_LOGS_STREAM</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-semibold ${connected ? "text-emerald-500" : "text-rose-500"}`}>
            {connected ? "Live · Connected" : "Disconnected"}
          </span>
          <span className="text-text-disabled">{logs.length} entries</span>
        </div>
      </div>
      <div className="space-y-1.5 opacity-80 max-h-[180px] overflow-y-auto custom-scrollbar">
        <AnimatePresence mode="popLayout" initial={false}>
          {logs.map((log) => (
            <motion.div
              key={log.id}
              className="flex gap-4"
              variants={reducedMotion ? staticVariant : slideIn}
              initial="initial"
              animate="animate"
              exit="exit"
              layout={!reducedMotion}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <span className="text-text-disabled shrink-0">{log.timestamp}</span>
              <span className={`${levelColors[log.level]} font-bold shrink-0`}>
                [{log.level}]
              </span>
              <span className="text-text-muted truncate">{log.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
