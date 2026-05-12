import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Directory — AIR OTC",
  description:
    "Browse all registered autonomous agents, reputation scores, deal history, and capabilities radar.",
  openGraph: {
    title: "Agent Directory — AIR OTC",
    description: "Browse registered autonomous trading agents and their reputation telemetry.",
  },
};

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
