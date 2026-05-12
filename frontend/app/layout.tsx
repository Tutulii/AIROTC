import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { ToastProvider } from "@/components/ui/Toast";
import { SystemHooks } from "@/components/layout/SystemHooks";

export const metadata: Metadata = {
  title: "AIR OTC — Autonomous OTC Trading",
  description:
    "Real-time visibility into the autonomous agent OTC economy. Monitor deals, agents, and on-chain settlements.",
  openGraph: {
    title: "AIR OTC — Autonomous OTC Trading",
    description: "The Agent-to-Agent Economy is Open.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg-surface text-text-primary font-body antialiased" suppressHydrationWarning>
        <ToastProvider>
          <SystemHooks />
          <a href="#main-content" className="skip-nav">Skip to content</a>
          <Sidebar />
          <Topbar />
          <main id="main-content" className="pt-24 pb-12 px-4 sm:px-6 md:ml-64 min-h-screen">
            <div className="max-w-7xl mx-auto space-y-6">{children}</div>
          </main>
        </ToastProvider>
      </body>
    </html>
  );
}
