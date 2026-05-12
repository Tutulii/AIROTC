"use client";

import {
  useState,
  useEffect,
  createContext,
  useContext,
  useCallback,
  useRef,
} from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

/* ─── Types ─── */

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  duration: number;
  createdAt: number;
}

interface ToastContextValue {
  addToast: (
    type: ToastType,
    message: string,
    opts?: { title?: string; duration?: number }
  ) => void;
  /** Convenience shortcuts */
  success: (message: string, opts?: { title?: string; duration?: number }) => void;
  error: (message: string, opts?: { title?: string; duration?: number }) => void;
  warn: (message: string, opts?: { title?: string; duration?: number }) => void;
  info: (message: string, opts?: { title?: string; duration?: number }) => void;
}

/* ─── Context ─── */

const ToastContext = createContext<ToastContextValue>({
  addToast: () => { },
  success: () => { },
  error: () => { },
  warn: () => { },
  info: () => { },
});

export const useToast = () => useContext(ToastContext);

/* ─── Config ─── */

const MAX_VISIBLE = 5;
const DEFAULT_DURATION = 5000;

const typeConfig: Record<
  ToastType,
  {
    border: string;
    icon: string;
    iconColor: string;
    bg: string;
    progressColor: string;
  }
> = {
  success: {
    border: "border-l-emerald-500",
    icon: "check_circle",
    iconColor: "text-emerald-500",
    bg: "bg-emerald-500/5",
    progressColor: "bg-emerald-500",
  },
  error: {
    border: "border-l-rose-500",
    icon: "error",
    iconColor: "text-rose-500",
    bg: "bg-rose-500/5",
    progressColor: "bg-rose-500",
  },
  warning: {
    border: "border-l-amber-500",
    icon: "warning",
    iconColor: "text-amber-500",
    bg: "bg-amber-500/5",
    progressColor: "bg-amber-500",
  },
  info: {
    border: "border-l-blue-400",
    icon: "info",
    iconColor: "text-blue-400",
    bg: "bg-blue-400/5",
    progressColor: "bg-blue-400",
  },
};

/* ─── Provider ─── */

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback(
    (
      type: ToastType,
      message: string,
      opts?: { title?: string; duration?: number }
    ) => {
      const id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const duration = opts?.duration ?? DEFAULT_DURATION;
      setToasts((prev) => {
        const next = [
          ...prev,
          { id, type, title: opts?.title, message, duration, createdAt: Date.now() },
        ];
        // Cap visible toasts — remove oldest
        return next.length > MAX_VISIBLE ? next.slice(-MAX_VISIBLE) : next;
      });
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback(
    (msg: string, opts?: { title?: string; duration?: number }) =>
      addToast("success", msg, opts),
    [addToast]
  );
  const error = useCallback(
    (msg: string, opts?: { title?: string; duration?: number }) =>
      addToast("error", msg, opts),
    [addToast]
  );
  const warn = useCallback(
    (msg: string, opts?: { title?: string; duration?: number }) =>
      addToast("warning", msg, opts),
    [addToast]
  );
  const info = useCallback(
    (msg: string, opts?: { title?: string; duration?: number }) =>
      addToast("info", msg, opts),
    [addToast]
  );

  return (
    <ToastContext.Provider value={{ addToast, success, error, warn, info }}>
      {children}
      {/* Toast container — bottom right, above status footer */}
      <div
        className="fixed bottom-6 right-6 z-[100] flex flex-col-reverse gap-3 w-full max-w-[380px] pointer-events-none"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={() => removeToast(toast.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/* ─── Individual Toast ─── */

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const config = typeConfig[toast.type];
  const reducedMotion = useReducedMotion();
  const [progress, setProgress] = useState(100);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startRef = useRef<number>(Date.now());
  const remainingRef = useRef<number>(toast.duration);

  // Auto-dismiss timer with pause/resume
  useEffect(() => {
    if (paused) return;

    startRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, remainingRef.current);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [paused, onDismiss]);

  // Progress bar animation
  useEffect(() => {
    if (paused) return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - toast.createdAt;
      const pct = Math.max(0, 100 - (elapsed / toast.duration) * 100);
      setProgress(pct);
      if (pct <= 0) clearInterval(interval);
    }, 50);

    return () => clearInterval(interval);
  }, [paused, toast.createdAt, toast.duration]);

  const handleMouseEnter = () => {
    setPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    remainingRef.current -= Date.now() - startRef.current;
  };

  const handleMouseLeave = () => {
    setPaused(false);
  };

  return (
    <motion.div
      layout={!reducedMotion}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 80, scale: 0.95 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 80, scale: 0.9 }}
      transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={`pointer-events-auto relative overflow-hidden bg-bg-elevated border border-border-subtle ${config.border} border-l-[3px] shadow-xl shadow-black/20 backdrop-blur-sm`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="alert"
      aria-atomic="true"
    >
      <div className={`absolute inset-0 ${config.bg} opacity-40`} />

      <div className="relative px-4 py-3 flex items-start gap-3">
        {/* Icon */}
        <span
          className={`material-symbols-outlined text-lg mt-0.5 ${config.iconColor} shrink-0`}
        >
          {config.icon}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {toast.title && (
            <div className="text-xs font-bold text-text-primary mb-0.5 font-headline">
              {toast.title}
            </div>
          )}
          <p className="text-sm text-text-secondary leading-snug">
            {toast.message}
          </p>
        </div>

        {/* Dismiss */}
        <button
          onClick={onDismiss}
          className="text-text-disabled hover:text-text-primary transition-colors shrink-0 mt-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
          aria-label="Dismiss notification"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-[2px] bg-border-subtle/30 w-full">
        <div
          className={`h-full ${config.progressColor} transition-none`}
          style={{
            width: `${progress}%`,
            opacity: paused ? 0.3 : 0.6,
          }}
        />
      </div>
    </motion.div>
  );
}
