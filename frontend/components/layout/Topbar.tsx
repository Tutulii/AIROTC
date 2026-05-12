"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { SimulateDealModal } from "@/components/ui/SimulateDealModal";

export function Topbar() {
  const [simOpen, setSimOpen] = useState(false);
  const pathname = usePathname();
  const simulationUiEnabled = process.env.NEXT_PUBLIC_ENABLE_SIMULATION_ROUTES === "true";
  const isDocs = pathname.startsWith("/docs");
  const isAgents = pathname.startsWith("/agents");
  const isDashboard = pathname === "/";

  return (
    <>
      <header className="fixed top-0 right-0 left-0 md:left-64 h-16 bg-bg-surface/80 backdrop-blur-md z-30 shadow-[0px_4px_24px_var(--color-accent-glow)] flex justify-between items-center px-6">
        <div className="flex items-center gap-8">
          {isAgents ? (
            <>
              <div className="relative hidden md:block">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-lg">
                  search
                </span>
                <input
                  className="bg-bg-highest border-none text-xs rounded-full py-2 pl-10 pr-4 w-72 focus:ring-1 focus:ring-accent transition-all font-mono text-text-primary"
                  placeholder="Search by ID or Wallet..."
                  type="text"
                />
              </div>
              <nav className="hidden lg:flex gap-6">
                <span className="text-accent border-b-2 border-accent pb-1 text-sm font-medium">
                  Dashboard
                </span>
                <span className="text-text-muted font-medium text-sm hover:text-accent transition-colors duration-200">
                  Deals
                </span>
              </nav>
            </>
          ) : (
            <>
              <span className="text-xl font-bold tracking-tighter text-accent font-headline">
                AIR OTC
              </span>
              <nav className="hidden lg:flex gap-6">
                <span className="text-text-muted font-medium text-sm hover:text-accent transition-colors duration-200">
                  Dashboard
                </span>
                <span className="text-text-muted font-medium text-sm hover:text-accent transition-colors duration-200">
                  Deals
                </span>
              </nav>
            </>
          )}
        </div>

        <div className="flex items-center gap-4">
          {isDocs ? (
            <button className="hidden sm:flex items-center gap-2 px-4 py-2 bg-accent text-[#00382b] text-sm font-bold tracking-tight hover:opacity-90 transition-all active:scale-95">
              Connect Wallet
            </button>
          ) : simulationUiEnabled && isDashboard ? (
            <button
              onClick={() => setSimOpen(true)}
              className="hidden sm:flex items-center gap-2 px-4 py-2 bg-accent-bg border border-accent/30 text-accent text-xs font-bold tracking-tight hover:bg-accent/20 transition-all"
            >
              <span className="material-symbols-outlined text-sm">play_arrow</span>
              SIMULATE DEAL
            </button>
          ) : null}
          <Link href="/docs" className="p-2 text-text-muted hover:text-accent transition-colors active:opacity-80">
            <span className="material-symbols-outlined">
              notifications_active
            </span>
          </Link>
          <Link href="/agents" className="p-2 text-text-muted hover:text-accent transition-colors active:opacity-80">
            <span className="material-symbols-outlined">
              settings_input_component
            </span>
          </Link>
          <div className="w-8 h-8 rounded-full bg-bg-highest border border-border-subtle flex items-center justify-center text-text-secondary overflow-hidden">
            <span className="material-symbols-outlined text-sm">terminal</span>
          </div>
        </div>
      </header>

      {simulationUiEnabled && (
        <SimulateDealModal isOpen={simOpen} onClose={() => setSimOpen(false)} />
      )}
    </>
  );
}
