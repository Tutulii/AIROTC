"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/explorer", label: "Explorer", icon: "query_stats" },
  { href: "/agents", label: "Agents", icon: "smart_toy" },
  { href: "/marketplace", label: "Marketplace", icon: "storefront" },
  { href: "/mcp-token", label: "MCP Token", icon: "key" },
  { href: "/docs", label: "Docs", icon: "description" },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="h-screen w-64 fixed left-0 border-r border-border-subtle bg-bg-surface flex flex-col py-8 z-40 hidden md:flex">
        <div className="px-6 mb-10">
          <h1 className="text-lg font-semibold text-white font-headline tracking-tight">
            AIR OTC
          </h1>
          <p className="text-[10px] text-text-muted font-mono mt-1">
            Autonomous OTC Trading
          </p>
        </div>

        <nav className="flex-1 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-6 py-3 transition-all group ${isActive(item.href)
                  ? "text-accent font-bold border-r-4 border-accent bg-gradient-to-r from-transparent to-accent-bg"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-card transition-all"
                }`}
            >
              <span
                className={`material-symbols-outlined mr-3 transition-transform group-hover:scale-110 ${isActive(item.href) ? "text-accent" : ""
                  }`}
              >
                {item.icon}
              </span>
              <span className="text-sm">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="px-6 mt-auto">
          <button className="w-full py-3 bg-bg-elevated border border-border-subtle hover:bg-bg-highest text-accent text-xs font-bold uppercase tracking-wider transition-all">
            Deploy New Agent
          </button>
          <div className="mt-6 pt-6 border-t border-border-subtle flex flex-col gap-2 font-mono text-[10px] text-text-muted">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-xs">
                local_gas_station
              </span>
              <span>Gas: 12 gwei</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-xs text-accent">
                sensors
              </span>
              <span>Network: Active</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-bg-elevated border-t border-border-subtle flex items-center justify-around z-50">
        {navItems.slice(0, 5).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-col items-center ${isActive(item.href) ? "text-accent" : "text-text-muted"
              }`}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            <span className="text-[10px] mt-1">{item.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
