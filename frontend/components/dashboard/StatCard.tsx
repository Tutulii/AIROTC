"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useCountUp, formatCount } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  change?: string;
  icon?: string;
  isPrimary?: boolean;
  suffix?: string;
  accentValue?: boolean;
  children?: React.ReactNode;
}

/** Extract numeric part from a value like "$42.8M" or "2,451" */
function extractNumber(val: string): number | null {
  const cleaned = val.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/** Format an animated number to match the original format */
function formatAnimatedValue(current: number, original: string): string {
  // Percent
  if (original.endsWith("%")) {
    return `${current.toFixed(1)}%`;
  }
  // Dollar with suffix
  const suffixMatch = original.match(/[KMB]$/);
  if (original.startsWith("$") && suffixMatch) {
    return `$${current.toFixed(1)}${suffixMatch[0]}`;
  }
  if (original.startsWith("$")) {
    return `$${formatCount(current)}`;
  }
  // Plain number
  return formatCount(Math.round(current));
}

function AnimatedValue({ value }: { value: string }) {
  const reducedMotion = useReducedMotion();
  const num = extractNumber(value);

  const animated = useCountUp(num ?? 0, reducedMotion ? 0 : 1200, true);

  if (num === null || reducedMotion) {
    return <>{value}</>;
  }

  return <>{formatAnimatedValue(animated, value)}</>;
}

export function StatCard({
  label,
  value,
  change,
  icon,
  isPrimary = false,
  suffix,
  accentValue = false,
  children,
}: StatCardProps) {
  const reducedMotion = useReducedMotion();

  if (isPrimary) {
    return (
      <motion.div
        className="lg:col-span-2 bg-bg-card p-6 flex flex-col justify-between border-l-2 border-accent group hover:bg-bg-card-hover transition-all duration-200 focus-within:ring-1 focus-within:ring-accent"
        whileHover={reducedMotion ? {} : { y: -2, boxShadow: "0 8px 24px rgba(70, 241, 197, 0.08)" }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        tabIndex={0}
        role="region"
        aria-label={`${label}: ${value}`}
      >
        <div className="flex justify-between items-start">
          <div>
            <span className="text-text-muted text-xs font-medium uppercase tracking-widest">
              {label}
            </span>
            <div className="flex items-baseline gap-4 mt-2">
              <h2 className="text-5xl sm:text-6xl font-headline font-bold text-text-primary leading-none">
                <AnimatedValue value={value} />
              </h2>
              {change && (
                <span className="px-2 py-1 bg-accent-bg text-accent text-xs font-mono font-bold">
                  {change}
                </span>
              )}
            </div>
          </div>
          {icon && (
            <motion.span
              className="material-symbols-outlined text-accent/30 text-4xl"
              animate={reducedMotion ? {} : { rotate: [0, 3, -3, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              {icon}
            </motion.span>
          )}
        </div>
        <div className="mt-8 flex gap-2">
          {[1, 0.4, 0.1, 0.05].map((opacity, i) => (
            <motion.div
              key={i}
              className={`h-1 flex-1 bg-accent`}
              style={{ opacity, transformOrigin: "left" }}
              initial={reducedMotion ? { scaleX: 1 } : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.6, delay: 0.2 + i * 0.15, ease: "easeOut" }}
            />
          ))}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="bg-bg-card p-5 border-l border-border-subtle hover:bg-bg-highest transition-all duration-200 focus-within:ring-1 focus-within:ring-accent"
      whileHover={reducedMotion ? {} : { y: -2, boxShadow: "0 8px 24px rgba(70, 241, 197, 0.06)" }}
      transition={{ duration: 0.2 }}
      tabIndex={0}
      role="region"
      aria-label={`${label}: ${value}`}
    >
      <span className="text-text-muted text-xs font-medium uppercase">
        {label}
      </span>
      <div className="mt-2 flex items-center justify-between">
        <span
          className={`text-xl sm:text-2xl font-mono font-medium ${accentValue ? "text-accent-dim" : ""}`}
        >
          <AnimatedValue value={value} />
          {suffix && (
            <span className="text-sm text-text-muted ml-1">{suffix}</span>
          )}
        </span>
        {icon && (
          <span className="material-symbols-outlined text-secondary text-sm">
            {icon}
          </span>
        )}
        {accentValue && (
          <motion.div
            className="w-2 h-2 rounded-full bg-accent"
            animate={reducedMotion ? {} : { scale: [1, 1.4, 1], opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>
      {children}
    </motion.div>
  );
}
