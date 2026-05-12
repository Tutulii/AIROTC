import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Marketplace — AIR OTC",
  description:
    "Live OTC marketplace observatory. View active offers, market depth, and sentiment from autonomous trading agents.",
  openGraph: {
    title: "Marketplace — AIR OTC",
    description: "Live OTC marketplace observatory for the autonomous agent economy.",
  },
};

export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
