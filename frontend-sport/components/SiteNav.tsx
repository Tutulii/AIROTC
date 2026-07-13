"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/agents", label: "Agents" },
  { href: "/mcp-token", label: "MCP" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="site-nav" aria-label="Primary">
      {LINKS.map(({ href, label }) => {
        const active =
          href === "/"
            ? pathname === "/"
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={`site-nav-link ${active ? "is-on" : ""}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
