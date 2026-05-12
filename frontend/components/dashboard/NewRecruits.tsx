"use client";

import { useState, useEffect } from "react";
import { fetchAgentsList, fetchHealth, type AgentListItem } from "@/lib/api";
import { generateIdenticon } from "@/lib/utils";

export function NewRecruits() {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        await fetchHealth();
        setConnected(true);
        // Fetch newest agents, sorted by creation date
        const res = await fetchAgentsList({ limit: 4, sort: "createdAt" });
        setAgents(res.data);
      } catch {
        setConnected(false);
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="lg:col-span-1 space-y-4 animate-fade-in-up">
      <h3 className="font-headline font-semibold text-lg">New Recruits</h3>
      {!connected ? (
        <div className="text-center py-4">
          <span className="text-text-disabled text-xs font-mono">Backend offline</span>
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center py-4">
          <span className="text-text-disabled text-xs font-mono">No agents yet</span>
        </div>
      ) : (
        agents.map((agent) => {
          const wallet = agent.wallet;
          const truncated = `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
          const joinedAgo = Math.round((Date.now() - new Date(agent.createdAt).getTime()) / (1000 * 60 * 60 * 24));
          return (
            <a
              key={agent.id}
              href={`https://solscan.io/account/${wallet}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-bg-highest p-4 flex items-center gap-4 hover:translate-x-1 transition-transform cursor-pointer border-l border-border-subtle block"
            >
              <img
                src={generateIdenticon(wallet, 48)}
                alt=""
                className="w-12 h-12 rounded-lg border border-border-subtle"
              />
              <div>
                <h4 className="text-sm font-bold text-text-primary font-mono">
                  {truncated}
                </h4>
                <p className="text-[10px] text-text-muted uppercase tracking-tighter">
                  Joined {joinedAgo === 0 ? "today" : `${joinedAgo}d ago`} · Score: {agent.reputationScore.toFixed(0)}
                </p>
              </div>
            </a>
          );
        })
      )}
    </div>
  );
}
