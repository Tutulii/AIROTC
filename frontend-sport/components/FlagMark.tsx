"use client";

import { useState } from "react";
import { flagEmoji, flagImageUrl, resolveCountry } from "@/lib/flags";
import { teamCode } from "@/lib/sport-utils";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<Size, string> = {
  xs: "h-5 w-5 text-[0.55rem]",
  sm: "h-6 w-6 text-[0.6rem]",
  md: "h-9 w-9 text-[0.65rem]",
  lg: "h-11 w-11 text-[0.7rem]",
  xl: "h-14 w-14 text-[0.75rem] md:h-16 md:w-16",
};

const CDN_W: Record<Size, number> = {
  xs: 40,
  sm: 40,
  md: 80,
  lg: 80,
  xl: 160,
};

/**
 * Circular country flag for a team name.
 * Prefers flagcdn PNG; falls back to emoji, then FIFA-style code.
 */
export function FlagMark({
  name,
  size = "md",
  className = "",
}: {
  name?: string | null;
  size?: Size;
  className?: string;
}) {
  const country = resolveCountry(name);
  const code = country?.code || teamCode(name);
  const [imgFailed, setImgFailed] = useState(false);
  const emoji =
    country && country.flagPath.length === 2 ? flagEmoji(country.flagPath) : null;

  const shell = `relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--line)] bg-[var(--surface-3)] shadow-[inset_0_1px_0_rgba(231,228,221,0.06)] ${SIZE_CLASS[size]} ${className}`;

  if (country && !imgFailed) {
    return (
      <span className={shell} title={name || code} aria-hidden>
        <img
          src={flagImageUrl(country.flagPath, CDN_W[size])}
          alt=""
          width={CDN_W[size]}
          height={CDN_W[size]}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }

  if (emoji) {
    return (
      <span
        className={`${shell} leading-none`}
        title={name || code}
        aria-hidden
        style={{ fontSize: size === "xl" ? "1.75rem" : size === "lg" ? "1.35rem" : "1rem" }}
      >
        {emoji}
      </span>
    );
  }

  return (
    <span
      className={`${shell} font-mono font-medium tracking-wide text-[var(--gold)]`}
      title={name || code}
      aria-hidden
    >
      {code.slice(0, 2)}
    </span>
  );
}
