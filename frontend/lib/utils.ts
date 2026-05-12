"use client";

import { useState, useEffect, useRef } from "react";

/**
 * Animates a number from 0 to `target` over `duration` ms.
 * Uses easeOutExpo for a satisfying tick-up effect.
 */
export function useCountUp(target: number, duration: number = 1200, startOnMount = true): number {
  const [current, setCurrent] = useState(0);
  const prevTarget = useRef(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!startOnMount) return;
    const from = prevTarget.current;
    const diff = target - from;
    if (diff === 0) return;

    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const value = from + diff * eased;
      setCurrent(value);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        prevTarget.current = target;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration, startOnMount]);

  return current;
}

/**
 * Formats a number with commas. Handles decimals if present.
 */
export function formatCount(n: number, decimals: number = 0): string {
  return n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Generates deterministic identicon SVG data URL from a wallet/ID string.
 * Creates a 5x5 mirrored grid pattern using the string's hash.
 */
export function generateIdenticon(seed: string, size: number = 64): string {
  // Simple hash
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }

  // Derive hue from hash for color
  const hue = Math.abs(hash % 360);
  const fg = `hsl(${hue}, 70%, 60%)`;
  const bg = `hsl(${hue}, 30%, 12%)`;

  // Generate 5x5 grid (mirrored on x-axis so we only need 3 columns)
  const cells: boolean[][] = [];
  for (let y = 0; y < 5; y++) {
    cells[y] = [];
    for (let x = 0; x < 3; x++) {
      // Use different bits of the hash
      const bit = (Math.abs(hash * (y * 3 + x + 1) * 7919) >> (y + x)) & 1;
      cells[y][x] = bit === 1;
    }
    // Mirror
    cells[y][3] = cells[y][1];
    cells[y][4] = cells[y][0];
  }

  const cellSize = size / 5;
  let rects = "";
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      if (cells[y][x]) {
        rects += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${fg}"/>`;
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}" rx="4"/>${rects}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
