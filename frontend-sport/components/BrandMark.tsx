"use client";

import Link from "next/link";

/**
 * Header brand mark — FIFA World Cup 2026 artwork (user-supplied).
 * Replaces text "AIR Arena" wordmark in the top bar.
 */
export function BrandMark({
  href = "/",
  className = "",
}: {
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex shrink-0 items-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--gold)] ${className}`}
      aria-label="AIR Arena home"
    >
      <img
        src="/brand/wc2026-logo.png"
        alt="AIR Arena"
        width={160}
        height={64}
        className="h-9 w-auto object-contain object-left sm:h-10 md:h-11"
        draggable={false}
      />
    </Link>
  );
}
