import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Developer Docs - AIR OTC",
  description: "AIR OTC integration docs for the TypeScript SDK, Python SDK, and MCP server.",
};

const surfaces = [
  {
    name: "TypeScript SDK",
    tag: "@agentotc/sdk",
    text: "Best choice for production agents that need the full current workflow surface.",
  },
  {
    name: "Python SDK",
    tag: "agentotc",
    text: "Best choice for Python automation, offer handling, ER flows, and PER flows with supplied encrypted terms or handoff bundles.",
  },
  {
    name: "MCP Server",
    tag: "@air-otc/mcp-server",
    text: "Best choice for external AI agents and operators that call AIR OTC through scoped tools.",
  },
];

const tsInstall = `cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm install
npm run build`;

const tsBuyer = `import { AgentOTC } from "@agentotc/sdk";

const buyer = new AgentOTC({
  walletPrivateKey: process.env.BUYER_PRIVATE_KEY!,
  apiUrl: "http://localhost:3000",
  wsUrl: "ws://localhost:8080",
  rpcUrl: "https://api.devnet.solana.com",
  environment: "devnet",
  privateMode: true,
  strictOpaquePerMode: true,
});

const result = await buyer.workflows.quickBuyPer({
  offerId: "OFFER_ID",
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    assetSymbol: "SOL",
    priceSol: 0.1,
    buyerCollateralSol: 0.02,
    sellerCollateralSol: 0.02,
    quantity: 1,
  },
  requireFullUmbraLifecycle: true,
});

if (!result.success) throw new Error(result.error);`;

const tsSeller = `import { AgentOTC } from "@agentotc/sdk";

const seller = new AgentOTC({
  walletPrivateKey: process.env.SELLER_PRIVATE_KEY!,
  apiUrl: "http://localhost:3000",
  wsUrl: "ws://localhost:8080",
  rpcUrl: "https://api.devnet.solana.com",
  environment: "devnet",
  privateMode: true,
  strictOpaquePerMode: true,
});

const result = await seller.workflows.quickSellPer({
  offer: {
    asset: "SOL",
    mode: "sell",
    amount: 1,
    price: 0.1,
    collateral: 0.02,
    rollupMode: "PER",
  },
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    assetSymbol: "SOL",
    priceSol: 0.1,
    buyerCollateralSol: 0.02,
    sellerCollateralSol: 0.02,
    quantity: 1,
  },
  deliveryContent: "ACCESS_TOKEN=ACCESS_TOKEN_12345",
  deliveryLabel: "AIR OTC encrypted delivery",
  requireFullUmbraLifecycle: true,
});

if (!result.success) throw new Error(result.error);`;

const pyInstall = `cd "/Users/tutul/Downloads/AIR OTC/sdk/python"
pip install .`;

const pyClient = `from agentotc import AgentOTC, AgentOTCConfig

client = AgentOTC(
    AgentOTCConfig(
        api_key="YOUR_API_KEY",
        wallet_private_key="YOUR_BASE58_PRIVATE_KEY",
        environment="devnet",
        api_url="http://localhost:3000",
        ws_url="ws://localhost:8080",
        rpc_url="https://api.devnet.solana.com",
        private_mode=True,
        strict_opaque_per_mode=True,
    )
)

await client.register()
await client.connect()`;

const pyEr = `from agentotc import QuickBuyErOptions, QuickSellErOptions

buyer_result = await client.workflows.quick_buy_er(
    QuickBuyErOptions(
        offer_id="OFFER_ID",
        max_price=0.1,
        collateral=0.02,
    )
)

seller_result = await client.workflows.quick_sell_er(
    QuickSellErOptions(
        offer={
            "asset": "SOL",
            "mode": "sell",
            "amount": 1,
            "price": 0.1,
            "collateral": 0.02,
            "rollupMode": "ER",
        },
        delivery_message="Delivery completed through AIR OTC Python SDK.",
    )
)`;

const pyPer = `from agentotc import PrivateAgreementTerms, QuickBuyPerOptions

terms = PrivateAgreementTerms(
    assetMint="So11111111111111111111111111111111111111112",
    assetSymbol="SOL",
    priceSol=0.1,
    buyerCollateralSol=0.02,
    sellerCollateralSol=0.02,
    quantity=1,
)

result = await client.workflows.quick_buy_per(
    QuickBuyPerOptions(
        offer_id="OFFER_ID",
        terms=terms,
        encrypted_terms={
            "buyerCollateral": {
                "identifierHex": "...",
                "account": "...",
                "fheType": 0,
            },
            "sellerCollateral": {
                "identifierHex": "...",
                "account": "...",
                "fheType": 0,
            },
            "paymentAmount": {
                "identifierHex": "...",
                "account": "...",
                "fheType": 0,
            },
            "settlementResult": {
                "identifierHex": "...",
                "account": "...",
                "fheType": 0,
            },
            "networkEncryptionKeyPda": "...",
        },
    )
)`;

const mcpInstall = `cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm install
npm run build`;

const mcpEnv = `AIR_OTC_API_URL=http://localhost:3000
AIR_OTC_MIDDLEMAN_URL=http://localhost:8080
AIR_OTC_MIDDLEMAN_HEALTH_URL=http://localhost:8081
AIR_OTC_WS_URL=ws://localhost:8080
AIR_OTC_RPC_URL=https://api.devnet.solana.com
AIR_OTC_TS_SDK_PATH="/Users/tutul/Downloads/AIR OTC/sdk/ts/dist/index.mjs"

# Required for write/PER tools
AIR_OTC_WALLET_PRIVATE_KEY=YOUR_BASE58_PRIVATE_KEY

# Optional MCP bearer auth
AIR_OTC_MCP_TOKEN=YOUR_OPERATOR_TOKEN
AIR_OTC_MCP_SCOPES=offers:read,offers:write,deals:read,per:run,proofs:read,vault:read,umbra:read`;

const mcpRun = `# Local stdio transport
node dist/index.js

# HTTP JSON-RPC transport
node dist/index.js --http

# HTTP endpoint
http://localhost:8787/mcp`;

const mcpTools = [
  ["airotc_health", "Read API and middleman health."],
  ["airotc_list_offers", "List marketplace offers."],
  ["airotc_create_offer", "Create an offer. Requires offers:write."],
  ["airotc_accept_offer", "Accept an offer. Requires offers:write."],
  ["airotc_run_per_buyer_flow", "Run TypeScript SDK PER buyer workflow. Requires per:run."],
  ["airotc_run_per_seller_flow", "Run TypeScript SDK PER seller workflow. Requires per:run."],
  ["airotc_get_deal_status", "Read ticket/deal status."],
  ["airotc_get_proof_bundle", "Read the evidence bundle for a ticket."],
  ["airotc_vault_status", "Read confidential/vault service status without exposing keys."],
  ["airotc_umbra_lifecycle_status", "Read Umbra lifecycle evidence for a ticket."],
];

const mcpResources = [
  "airotc://deals/{ticketId}",
  "airotc://proofs/{ticketId}",
  "airotc://vault/status",
];

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle/30 bg-bg-card">
      <div className="flex items-center justify-between border-b border-border-subtle/30 bg-bg-highest px-4 py-2">
        <span className="font-mono text-xs text-text-muted">{title}</span>
        <span className="material-symbols-outlined text-sm text-text-muted">content_copy</span>
      </div>
      <pre className="overflow-x-auto p-5">
        <code className="font-mono text-xs leading-relaxed text-text-secondary">{code}</code>
      </pre>
    </div>
  );
}

function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="max-w-3xl">
      <span className="mb-3 block font-mono text-xs uppercase tracking-[0.22em] text-secondary">
        {eyebrow}
      </span>
      <h2 className="font-headline text-3xl font-semibold text-white">{title}</h2>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">{children}</p>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="space-y-12">
      <header className="py-10">
        <span className="mb-4 block font-mono text-sm uppercase tracking-[0.25em] text-secondary">
          Developer Integration Docs
        </span>
        <h1 className="mb-6 max-w-5xl font-headline text-5xl font-bold leading-tight tracking-tighter text-white md:text-7xl">
          Build agents with
          <br />
          <span className="text-accent">SDK, Python SDK, or MCP.</span>
        </h1>
        <p className="mb-8 max-w-3xl text-lg leading-relaxed text-text-muted">
          Pick the surface that matches your agent. Use the TypeScript SDK for the fullest workflow
          control, the Python SDK for Python-native automation, or MCP when an external AI operator
          needs scoped AIR OTC tools.
        </p>
        <div className="flex flex-wrap gap-4">
          <a
            href="#typescript-sdk"
            className="bg-accent px-8 py-4 font-headline text-sm font-bold uppercase tracking-widest text-on-primary transition-all hover:opacity-90"
          >
            TypeScript SDK
          </a>
          <a
            href="#python-sdk"
            className="border border-secondary/40 px-8 py-4 font-headline text-sm font-bold uppercase tracking-widest text-secondary transition-all hover:bg-secondary/5"
          >
            Python SDK
          </a>
          <a
            href="#mcp"
            className="border border-border-subtle px-8 py-4 font-headline text-sm font-bold uppercase tracking-widest text-text-secondary transition-all hover:bg-bg-card"
          >
            MCP
          </a>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {surfaces.map((surface) => (
          <div key={surface.name} className="border border-border-subtle bg-bg-card p-6">
            <span className="mb-4 inline-block font-mono text-xs text-secondary">{surface.tag}</span>
            <h2 className="mb-3 font-headline text-2xl font-semibold text-white">{surface.name}</h2>
            <p className="text-sm leading-relaxed text-text-muted">{surface.text}</p>
          </div>
        ))}
      </section>

      <section id="typescript-sdk" className="space-y-6">
        <SectionTitle eyebrow="01" title="TypeScript SDK">
          Use <span className="font-mono text-text-secondary">@agentotc/sdk</span> when your agent is
          Node-based or when you need the strongest current PER workflow surface.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <CodeBlock title="install.sh" code={tsInstall} />
          <CodeBlock title="per-buyer.ts" code={tsBuyer} />
          <CodeBlock title="per-seller.ts" code={tsSeller} />
          <div className="border border-border-subtle bg-bg-elevated p-6">
            <h3 className="mb-4 font-headline text-xl font-semibold text-white">Available Workflows</h3>
            <div className="space-y-3 font-mono text-sm text-text-secondary">
              <div>client.workflows.quickBuyEr(...)</div>
              <div>client.workflows.quickSellEr(...)</div>
              <div>client.workflows.quickBuyPer(...)</div>
              <div>client.workflows.quickSellPer(...)</div>
              <div>client.workflows.runBuyerFlow(...)</div>
              <div>client.workflows.runSellerFlow(...)</div>
            </div>
          </div>
        </div>
      </section>

      <section id="python-sdk" className="space-y-6">
        <SectionTitle eyebrow="02" title="Python SDK">
          Use <span className="font-mono text-text-secondary">agentotc</span> for Python agents that
          need registration, offers, live deals, ER workflows, and PER workflow entrypoints.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <CodeBlock title="install.sh" code={pyInstall} />
          <CodeBlock title="client.py" code={pyClient} />
          <CodeBlock title="er-workflows.py" code={pyEr} />
          <CodeBlock title="per-buyer.py" code={pyPer} />
        </div>
        <div className="border border-border-subtle bg-bg-card p-6">
          <h3 className="mb-3 font-headline text-xl font-semibold text-white">Python PER Input Rule</h3>
          <p className="text-sm leading-relaxed text-text-muted">
            Python PER accepts <span className="font-mono text-text-secondary">encrypted_terms</span>{" "}
            or a prebuilt <span className="font-mono text-text-secondary">handoff_bundle</span>. That
            is the correct input boundary for the current Python SDK.
          </p>
        </div>
      </section>

      <section id="mcp" className="space-y-6">
        <SectionTitle eyebrow="03" title="MCP Server">
          Use <span className="font-mono text-text-secondary">@air-otc/mcp-server</span> when an AI
          agent or operator should call AIR OTC as tools instead of importing the SDK directly.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <CodeBlock title="install.sh" code={mcpInstall} />
          <CodeBlock title=".env" code={mcpEnv} />
          <CodeBlock title="run.sh" code={mcpRun} />
          <div className="border border-border-subtle bg-bg-card p-6">
            <h3 className="mb-4 font-headline text-xl font-semibold text-white">Tools</h3>
            <div className="space-y-3">
              {mcpTools.map(([name, description]) => (
                <div key={name} className="grid grid-cols-1 gap-1 border-b border-border-subtle/30 pb-3 last:border-b-0">
                  <span className="font-mono text-xs text-secondary">{name}</span>
                  <span className="text-sm text-text-muted">{description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="border border-border-subtle bg-bg-elevated p-6">
            <h3 className="mb-4 font-headline text-xl font-semibold text-white">Resources</h3>
            <div className="space-y-3">
              {mcpResources.map((resource) => (
                <div key={resource} className="font-mono text-sm text-text-secondary">
                  {resource}
                </div>
              ))}
            </div>
          </div>
          <div className="border border-border-subtle bg-bg-elevated p-6">
            <h3 className="mb-4 font-headline text-xl font-semibold text-white">Auth Model</h3>
            <p className="text-sm leading-relaxed text-text-muted">
              Read tools use read scopes. Offer mutations require{" "}
              <span className="font-mono text-text-secondary">offers:write</span>. PER run tools
              require <span className="font-mono text-text-secondary">per:run</span> and a configured{" "}
              <span className="font-mono text-text-secondary">AIR_OTC_WALLET_PRIVATE_KEY</span>. One
              MCP server instance acts as one configured wallet identity.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
