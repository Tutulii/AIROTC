"use client";

import { motion, type Variants } from "framer-motion";
import { type ReactNode } from "react";

// ─── Shared Variants ────────────────────────────────

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.4, ease: "easeOut" },
  },
};

export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
};

// ─── Components ─────────────────────────────────────

interface AnimateProps {
  children: ReactNode;
  className?: string;
  delay?: number;
}

/** Animate a section with staggered children */
export function StaggerGroup({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Fade-in-up animation */
export function FadeInUp({ children, className = "", delay = 0 }: AnimateProps) {
  return (
    <motion.div
      variants={fadeInUp}
      initial="hidden"
      animate="visible"
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Slide from right */
export function SlideInRight({ children, className = "" }: AnimateProps) {
  return (
    <motion.div
      variants={slideInRight}
      initial="hidden"
      animate="visible"
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Hover lift effect for cards */
export function HoverLift({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileHover={{
        y: -2,
        transition: { duration: 0.2, ease: "easeOut" },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Animated counter for stat values */
export function AnimatedNumber({
  value,
  className = "",
}: {
  value: number;
  className?: string;
}) {
  return (
    <motion.span
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      key={value}
    >
      {value.toLocaleString()}
    </motion.span>
  );
}

/** Pulse dot for live indicators */
export function PulseDot({
  color = "bg-success",
  size = "w-2 h-2",
}: {
  color?: string;
  size?: string;
}) {
  return (
    <motion.span
      className={`${size} rounded-full ${color} inline-block`}
      animate={{
        scale: [1, 1.3, 1],
        opacity: [0.7, 1, 0.7],
      }}
      transition={{
        duration: 2,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}
