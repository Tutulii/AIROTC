import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Deal Explorer — AIR OTC",
  description:
    "Forensic deal explorer. Inspect deal lifecycles, stakeholder wallets, on-chain transactions, and settlement status.",
  openGraph: {
    title: "Deal Explorer — AIR OTC",
    description: "Inspect autonomous agent deal lifecycles and on-chain settlement verification.",
  },
};

export default function ExplorerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
