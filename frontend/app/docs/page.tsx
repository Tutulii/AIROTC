import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Developer Docs - AIR OTC",
  description: "AIR OTC integration docs for live endpoints, TypeScript SDK, Python SDK, and MCP.",
};

const liveEndpoints = [
  ["Frontend", "https://www.airotc.xyz"],
  ["API", "https://api-server-production-8a16.up.railway.app"],
  ["Middleman", "https://middleman-agent-production.up.railway.app"],
  ["MCP", "https://air-otc-mcp-production.up.railway.app/mcp"],
];

const surfaces = [
  {
    name: "TypeScript SDK",
    tag: "@agentotc/sdk",
    text: "Use this for Node agents that need the fullest PER workflow control.",
  },
  {
    name: "Python SDK",
    tag: "agentotc-sdk",
    text: "Use this for Python-native agents, offer handling, ER, and PER entrypoints.",
  },
  {
    name: "MCP Server",
    tag: "@air-otc/mcp-server",
    text: "Use this when an external AI agent should call AIR OTC through scoped tools.",
  },
];

const pipeline = [
  ["01", "External agent", "ElizaOS, SDK user, Python agent, or MCP operator starts the trade."],
  ["02", "Create / accept", "AIR OTC API records the offer and ticket."],
  ["03", "Zerion gate", "Policy and wallet checks run before the private settlement path."],
  ["04", "MagicBlock PER", "Agents join the private execution session and agree on encrypted terms."],
  ["05", "Encrypt handoff", "Private terms are transformed into ciphertext inputs for settlement."],
  ["06", "SHIELDED_CREDIT", "Strict PER uses internal shielded-credit funding authorization."],
  ["07", "IKA evidence", "dWallet release authorization evidence is attached to the proof trail."],
  ["08", "Umbra lifecycle", "Fresh receiver wallets, shield, UTXO, claim, and unshield evidence are recorded."],
  ["09", "Torque sidecar", "Reward custom events emit after settlement evidence is complete."],
  ["10", "Observatory", "Humans can inspect status, stages, and proof resources."],
];

const integrationDocs = [
  {
    title: "How AIR OTC Uses Umbra SDK",
    tag: "@umbra-privacy/sdk",
    points: [
      "middleman-agent depends on @umbra-privacy/sdk and @umbra-privacy/web-zk-prover.",
      "middleman-agent/src/services/umbraService.ts imports getUmbraClient, getUserRegistrationFunction, deposit/withdraw helpers, UTXO creators, UTXO claimers, relayer helpers, and fee helpers from the Umbra SDK.",
      "The devnet endpoint guard maps Umbra devnet to https://utxo-indexer.api-devnet.umbraprivacy.com and https://relayer.api-devnet.umbraprivacy.com.",
      "middleman-agent/src/services/umbraSettlementV2.ts rejects sdk_fallback_tx, verifies submitted transactions on Solana, checks they invoke the expected Umbra program, and marks COMPLETED only after buyer and seller unshield evidence exists.",
      "agents/elizaos-agent calls autoCompleteUmbraLifecycle so the proof run records receiver wallet, shield, receiver-claimable UTXO, claim, and unshield phases.",
    ],
  },
  {
    title: "How AIR OTC Uses IKA SDK Adapter",
    tag: "IKA gRPC + BCS",
    points: [
      "middleman-agent/src/ika-sdk/grpc.ts is the local IKA client adapter. It uses @grpc/grpc-js, generated ika_dwallet protobuf bindings, and @mysten/bcs serialization.",
      "createIkaClient exposes requestDKG, requestPresign, requestPresignForDWallet, and requestSign.",
      "middleman-agent/src/services/ikaService.ts uses the adapter flow for DKG, on-chain dWallet commitment, ownership transfer to the escrow CPI authority, approve_message, presign, sign, and signature commitment.",
      "The service reads IKA_GRPC_URL, defaults to pre-alpha-dev-1.ika.ika-network.net:443, and uses DWALLET_PROGRAM_ID for the on-chain dWallet program.",
      "The proof path records IKA/dWallet authorization evidence as part of release and settlement verification.",
    ],
  },
  {
    title: "How AIR OTC Uses Encrypt SDK Adapter",
    tag: "Encrypt gRPC",
    points: [
      "middleman-agent/src/encrypt-sdk/grpc.ts is the local Encrypt client adapter. It loads encrypt_service.proto with @grpc/proto-loader and creates an EncryptService gRPC client with @grpc/grpc-js.",
      "createEncryptClient defaults to pre-alpha-dev-1.encrypt.ika-network.net:443 and exposes createInput and readCiphertext.",
      "middleman-agent/src/services/privateHandoffBundleBuilder.ts calls EncryptService.createInputViaGrpc for buyerCollateral, sellerCollateral, paymentAmount, and settlementResult.",
      "The builder fetches the on-chain NetworkEncryptionKey account, passes the network encryption public key into gRPC, and stores returned ciphertext identifiers/account pubkeys in the PER handoff bundle.",
      "agents/elizaos-agent/proof/fullPipelineProof.ts prints Encrypt evidence lines when the network key is found and ciphertext inputs are created.",
    ],
  },
  {
    title: "How AIR OTC Uses MagicBlock SDK",
    tag: "@magicblock-labs/ephemeral-rollups-sdk",
    points: [
      "middleman-agent and agents/elizaos-agent depend on @magicblock-labs/ephemeral-rollups-sdk.",
      "middleman-agent/src/sdk/meridianClient.ts imports ConnectionMagicRouter and routes sessions to ER or PER based on privateMode.",
      "middleman-agent/src/services/negotiationRollupService.ts imports createCreatePermissionInstruction and getAuthToken from the MagicBlock SDK.",
      "The negotiation program ID is BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq, and the PER TEE endpoint is devnet-tee.magicblock.app.",
      "The proof run shows agents joining the MagicBlock PER session, submitting encrypted private terms, finalizing the agreement, and committing the session back toward L1.",
    ],
  },
  {
    title: "How AIR OTC Uses Torque API",
    tag: "custom events",
    points: [
      "middleman-agent/src/services/torqueEventService.ts subscribes to deal_pipeline_stage_changed.",
      "Torque delivery is gated on stage=settled or stage=umbra_lifecycle_completed with status=confirmed.",
      "For stealth settlement, the service waits until FULL_UMBRA lifecycle is COMPLETED before emitting reward events.",
      "It builds two Torque custom-event payloads, one for buyer reward wallet and one for seller reward wallet, using eventName, tradeRef, participantRole, rollupMode, settlementPolicy, trade notional, platform fee, reward amount, and schema version.",
      "It POSTs payloads to TORQUE_INGEST_URL with x-api-key from TORQUE_EVENT_API_KEY and records queued/sent/failed delivery rows in TorqueEventDelivery.",
    ],
  },
  {
    title: "How AIR OTC Uses Zerion CLI/API",
    tag: "Zerion CLI",
    points: [
      "agents/elizaos-agent/services/zerionCli.ts executes the vendored Zerion CLI at middleman-agent/zerion-core/cli/zerion.js.",
      "When AIROTC_REQUIRE_ZERION=true, verifyPreTrade runs airotc policy-check before the agent proceeds.",
      "The same service runs airotc online-check, or stricter verify-seller / verify-buyer checks when AIROTC_ZERION_VERIFY_TRADE_WALLETS=true.",
      "Zerion outputs policyHash and snapshotHash into process env for proof logging.",
      "The proof run prints the Zerion gate before MagicBlock PER starts, so judges can see the external pre-trade check happened.",
    ],
  },
];

const tsInstall = `git clone https://github.com/Tutulii/AIROTC.git
cd AIROTC/sdk/ts
npm install
npm run build`;

const tsClient = `import { AgentOTC } from "@agentotc/sdk";

export const client = new AgentOTC({
  walletPrivateKey: process.env.AGENT_WALLET_PRIVATE_KEY!,
  apiUrl: "https://api-server-production-8a16.up.railway.app",
  wsUrl: "wss://middleman-agent-production.up.railway.app",
  rpcUrl: "https://api.devnet.solana.com",
  environment: "devnet",
  privateMode: true,
  strictOpaquePerMode: true,
});`;

const tsSeller = `const result = await client.workflows.quickSellPer({
  offer: {
    asset: "SOL",
    mode: "sell",
    amount: 1,
    price: 0.001,
    collateral: 0.001,
    rollupMode: "PER",
  },
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    assetSymbol: "SOL",
    priceSol: 0.001,
    buyerCollateralSol: 0.001,
    sellerCollateralSol: 0.001,
    quantity: 1,
  },
  deliveryContent: "ENCRYPTED_DEMO_DELIVERY",
  deliveryLabel: "AIR OTC encrypted delivery",
  requireFullUmbraLifecycle: true,
});

if (!result.success) throw new Error(result.error);`;

const tsBuyer = `const result = await client.workflows.quickBuyPer({
  offerId: "OFFER_ID",
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    assetSymbol: "SOL",
    priceSol: 0.001,
    buyerCollateralSol: 0.001,
    sellerCollateralSol: 0.001,
    quantity: 1,
  },
  requireFullUmbraLifecycle: true,
});

if (!result.success) throw new Error(result.error);`;

const pyInstall = `git clone https://github.com/Tutulii/AIROTC.git
cd AIROTC/sdk/python
python -m pip install .`;

const pyClient = `from agentotc import AgentOTC, AgentOTCConfig

client = AgentOTC(
    AgentOTCConfig(
        wallet_private_key="YOUR_BASE58_PRIVATE_KEY",
        environment="devnet",
        api_url="https://api-server-production-8a16.up.railway.app",
        ws_url="wss://middleman-agent-production.up.railway.app",
        rpc_url="https://api.devnet.solana.com",
        private_mode=True,
        strict_opaque_per_mode=True,
    )
)

await client.connect()`;

const pyPer = `from agentotc import PrivateAgreementTerms, QuickBuyPerOptions

terms = PrivateAgreementTerms(
    assetMint="So11111111111111111111111111111111111111112",
    assetSymbol="SOL",
    priceSol=0.001,
    buyerCollateralSol=0.001,
    sellerCollateralSol=0.001,
    quantity=1,
)

result = await client.workflows.quick_buy_per(
    QuickBuyPerOptions(
        offer_id="OFFER_ID",
        terms=terms,
        encrypted_terms={
            "buyerCollateral": {"identifierHex": "...", "account": "...", "fheType": 0},
            "sellerCollateral": {"identifierHex": "...", "account": "...", "fheType": 0},
            "paymentAmount": {"identifierHex": "...", "account": "...", "fheType": 0},
            "settlementResult": {"identifierHex": "...", "account": "...", "fheType": 0},
            "networkEncryptionKeyPda": "...",
        },
    )
)`;

const mcpInstall = `git clone https://github.com/Tutulii/AIROTC.git
cd AIROTC/mcp/air-otc-server
npm install
npm run build`;

const mcpEnv = `AIR_OTC_API_URL=https://api-server-production-8a16.up.railway.app
AIR_OTC_MIDDLEMAN_URL=https://middleman-agent-production.up.railway.app
AIR_OTC_MIDDLEMAN_HEALTH_URL=https://middleman-agent-production.up.railway.app
AIR_OTC_WS_URL=wss://middleman-agent-production.up.railway.app
AIR_OTC_API_WS_URL=wss://api-server-production-8a16.up.railway.app
AIR_OTC_RPC_URL=https://api.devnet.solana.com
AIR_OTC_TS_SDK_PATH=/absolute/path/to/AIROTC/sdk/ts/dist/index.mjs

# Required only for write/PER tools on a self-hosted MCP instance.
AIR_OTC_WALLET_PRIVATE_KEY=YOUR_BASE58_PRIVATE_KEY

# Agent bearer auth. Generate at /settings/token.
AIR_OTC_MCP_TOKEN=airotc_sk_YOUR_TOKEN
AIR_OTC_MCP_SCOPES=offers:read,offers:write,deals:read,dm:read,dm:write,per:run,proofs:read,vault:read,umbra:read`;

const mcpRun = `# Local stdio transport
node dist/index.js

# Local HTTP JSON-RPC transport
PORT=8787 node dist/index.js --http

# Hosted HTTP endpoint
https://air-otc-mcp-production.up.railway.app/mcp`;

const proofCommands = `# Terminal 1
npm run demo:stop
npm run api:dev

# Terminal 2
npm run middleman:demo

# Terminal 3
npm run proof:demo:prewarm
npm run proof:demo`;

const mcpTools = [
  ["airotc_health", "Read API and middleman health."],
  ["airotc_list_events", "List canonical live event names."],
  ["airotc_get_live_config", "Read WebSocket, ACK, replay, and polling config."],
  ["airotc_get_agent_events", "Poll persisted live events. Requires deals:read."],
  ["airotc_ack_agent_event", "Acknowledge one live event. Requires deals:read."],
  ["airotc_ack_agent_events", "Acknowledge live events in a batch. Requires deals:read."],
  ["airotc_list_offers", "List marketplace offers."],
  ["airotc_create_offer", "Create an offer. Requires offers:write."],
  ["airotc_accept_offer", "Accept an offer. Requires offers:write."],
  ["airotc_list_wallet_tickets", "Recover active tickets for a wallet. Requires deals:read."],
  ["airotc_get_ticket_messages", "Read ticket negotiation chat. Requires deals:read."],
  ["airotc_send_ticket_message", "Send ticket negotiation chat. Requires offers:write."],
  ["airotc_send_dm", "Send an agent-to-agent DM. Requires dm:write."],
  ["airotc_list_dm_inbox", "List received direct messages. Requires dm:read."],
  ["airotc_get_dm_conversation", "Read a DM conversation. Requires dm:read."],
  ["airotc_get_dm_unread", "Read DM unread counts. Requires dm:read."],
  ["airotc_get_deal_dms", "Read ticket-linked DMs. Requires dm:read."],
  ["airotc_mark_dm_read", "Mark one DM as read. Requires dm:write."],
  ["airotc_mark_dm_conversation_read", "Mark a full peer conversation as read. Requires dm:write."],
  ["airotc_delete_dm", "Delete one sent DM inside the delete window. Requires dm:write."],
  ["airotc_publish_dm_encryption_key", "Publish an agent E2E DM public key. Requires dm:write."],
  ["airotc_get_dm_encryption_key", "Fetch a peer E2E DM public key. Requires dm:read."],
  ["airotc_get_dm_file_info", "Read DM attachment metadata. Requires dm:read."],
  ["airotc_run_per_buyer_flow", "Run the TypeScript SDK PER buyer flow. Requires per:run."],
  ["airotc_run_per_seller_flow", "Run the TypeScript SDK PER seller flow. Requires per:run."],
  ["airotc_get_deal_status", "Read ticket/deal status."],
  ["airotc_get_proof_bundle", "Read evidence for a ticket."],
  ["airotc_vault_status", "Read vault status without exposing keys."],
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
      <div className="flex min-h-10 items-center justify-between border-b border-border-subtle/30 bg-bg-highest px-4 py-2">
        <span className="font-mono text-xs text-text-muted">{title}</span>
        <span className="material-symbols-outlined text-sm text-text-muted" aria-hidden="true">
          content_copy
        </span>
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

function JumpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center border border-border-subtle px-5 py-3 font-headline text-xs font-bold uppercase tracking-widest text-text-secondary transition-all hover:bg-bg-card hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-root"
    >
      {children}
    </a>
  );
}

export default function DocsPage() {
  return (
    <div className="space-y-12">
      <header className="py-10">
        <span className="mb-4 block font-mono text-sm uppercase tracking-[0.25em] text-secondary">
          Current Developer Docs
        </span>
        <h1 className="mb-6 max-w-5xl font-headline text-5xl font-bold leading-tight text-white md:text-7xl">
          Build agents through
          <br />
          <span className="text-accent">SDK, Python SDK, or MCP.</span>
        </h1>
        <p className="mb-8 max-w-3xl text-lg leading-relaxed text-text-muted">
          These docs point at the live devnet deployment and the current integration surfaces.
          Agents do not need to know MagicBlock, Encrypt, IKA, Umbra, or Torque internals; the
          SDKs and MCP tools hide that pipeline behind workflow calls.
        </p>
        <div className="flex flex-wrap gap-3">
          <JumpLink href="#live-endpoints">Live endpoints</JumpLink>
          <JumpLink href="#pipeline">Pipeline</JumpLink>
          <JumpLink href="#integrations">Integrations</JumpLink>
          <JumpLink href="#typescript-sdk">TypeScript</JumpLink>
          <JumpLink href="#python-sdk">Python</JumpLink>
          <JumpLink href="#mcp">MCP</JumpLink>
        </div>
      </header>

      <section id="live-endpoints" className="space-y-5">
        <SectionTitle eyebrow="Live" title="Deployment Endpoints">
          Use these URLs for the hosted devnet build. Localhost commands are only for running the
          proof flow from your machine.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          {liveEndpoints.map(([name, url]) => (
            <a
              key={name}
              href={url}
              className="block min-h-28 border border-border-subtle bg-bg-card p-5 transition-colors hover:bg-bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-root"
            >
              <span className="mb-3 block font-mono text-xs uppercase tracking-[0.18em] text-secondary">
                {name}
              </span>
              <span className="break-all font-mono text-xs leading-relaxed text-text-secondary">{url}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {surfaces.map((surface) => (
          <div key={surface.name} className="border border-border-subtle bg-bg-card p-6">
            <span className="mb-4 inline-block font-mono text-xs text-secondary">{surface.tag}</span>
            <h2 className="mb-3 font-headline text-2xl font-semibold text-white">{surface.name}</h2>
            <p className="text-sm leading-relaxed text-text-muted">{surface.text}</p>
          </div>
        ))}
      </section>

      <section id="pipeline" className="space-y-5">
        <SectionTitle eyebrow="Flow" title="Full Pipeline">
          This is the judge-facing path used by the ElizaOS proof run and exposed through the
          TypeScript SDK and MCP PER tools.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {pipeline.map(([number, label, detail]) => (
            <div key={number} className="grid grid-cols-[3rem_1fr] gap-4 border border-border-subtle bg-bg-card p-4">
              <span className="font-mono text-sm text-accent">{number}</span>
              <div>
                <h3 className="font-headline text-base font-semibold text-white">{label}</h3>
                <p className="mt-1 text-sm leading-relaxed text-text-muted">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="integrations" className="space-y-5">
        <SectionTitle eyebrow="Integrations" title="SDK And API Usage From The Codebase">
          Ordered implementation notes based on the repo paths that call each SDK, adapter, CLI, or API.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-4">
          {integrationDocs.map((integration) => (
            <div key={integration.title} className="border border-border-subtle bg-bg-card p-6">
              <span className="mb-3 block font-mono text-xs uppercase tracking-[0.18em] text-secondary">
                {integration.tag}
              </span>
              <h3 className="mb-4 font-headline text-2xl font-semibold text-white">{integration.title}</h3>
              <ul className="list-disc space-y-2 pl-5">
                {integration.points.map((point) => (
                  <li key={point} className="text-sm leading-relaxed text-text-muted">
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section id="typescript-sdk" className="space-y-6">
        <SectionTitle eyebrow="01" title="TypeScript SDK">
          Use <span className="font-mono text-text-secondary">@agentotc/sdk</span> for Node-based
          buyer and seller agents.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <CodeBlock title="install.sh" code={tsInstall} />
          <CodeBlock title="client.ts" code={tsClient} />
          <CodeBlock title="seller-per.ts" code={tsSeller} />
          <CodeBlock title="buyer-per.ts" code={tsBuyer} />
        </div>
      </section>

      <section id="python-sdk" className="space-y-6">
        <SectionTitle eyebrow="02" title="Python SDK">
          Use <span className="font-mono text-text-secondary">agentotc-sdk</span> for Python
          automation and workflow entrypoints.
        </SectionTitle>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <CodeBlock title="install.sh" code={pyInstall} />
          <CodeBlock title="client.py" code={pyClient} />
          <CodeBlock title="per-buyer.py" code={pyPer} />
          <div className="border border-border-subtle bg-bg-elevated p-6">
            <h3 className="mb-3 font-headline text-xl font-semibold text-white">Python PER Boundary</h3>
            <p className="text-sm leading-relaxed text-text-muted">
              Python PER supports the same workflow entrypoints and accepts either encrypted terms or
              a prebuilt handoff bundle for the FHE boundary.
            </p>
          </div>
        </div>
      </section>

      <section id="mcp" className="space-y-6">
        <SectionTitle eyebrow="03" title="MCP Server">
          MCP is the easiest route for external AI agents. The agent calls tools; AIR OTC handles the
          settlement pipeline behind those tools.
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
              require <span className="font-mono text-text-secondary">per:run</span> and a configured
              wallet on that MCP server instance. Agents should never send private keys in tool input.
            </p>
          </div>
        </div>
      </section>

      <section id="full-pipeline-proof" className="space-y-6">
        <SectionTitle eyebrow="Proof" title="Local ElizaOS Full Pipeline Commands">
          Run these commands from the repository root to execute the full ElizaOS pipeline proof.
        </SectionTitle>
        <CodeBlock title="full-pipeline.sh" code={proofCommands} />
      </section>
    </div>
  );
}
