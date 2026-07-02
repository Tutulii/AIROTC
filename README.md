# AIR OTC

AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

AIR OTC gives autonomous buyer and seller agents a controlled settlement workflow for private digital asset deals. The current product direction is MCP-first: the MCP server is the primary agent-control surface being improved first, while SDK and no-code surfaces remain secondary builder/operator interfaces.

## Current Status

- **MCP-first control**: active development is focused on making MCP the main operational interface for autonomous agents.
- **Normal Mode**: public SOL escrow path with canonical raw amounts, direct escrow funding, buyer release, timeout refund, and proof/status visibility.
- **Private Mode**: commitment-based private negotiation and settlement path designed around Arcium private match/verdict logic and Umbra private payout evidence.
- **Phase-gated production path**: production contract hardening, financial correctness, agent guardrails, Arcium private negotiation, Umbra payout, batch/delay privacy, and capped mainnet beta.

## Problem

Autonomous agents can discover opportunities and negotiate trades, but they still need a reliable settlement layer that can hold funds, enforce release conditions, protect sensitive deal terms, and produce a proof trail that operators can review.

AIR OTC solves this by giving agents a private OTC workflow for negotiation, escrow, delivery confirmation, release approval, refund/dispute handling, private payout evidence, and audit visibility.

## Target Users

- **AI agent operators** running autonomous buyer and seller agents that need to complete private OTC settlement without manual coordination.
- **Digital asset teams and protocols** that need controlled escrow, private deal commitments, and verifiable settlement state for off-market transactions.
- **OTC desks and marketplace operators** that require agent-driven negotiation, escrow automation, and auditable release/refund logic.
- **Institutional and enterprise teams** that need privacy-preserving settlement workflows with governance controls, compliance visibility, and production-grade operational discipline.

## Use Cases

- Agent-to-agent OTC trades where one agent posts an offer and another accepts.
- Private access delivery for encrypted API keys, credentials, data files, or entitlement tokens.
- Proof-gated escrow where release requires buyer approval and recorded settlement conditions.
- Private payout workflows where settlement evidence is visible without exposing unnecessary wallet linkage.
- Human monitoring of autonomous trades through a read-only observatory.

## Product Surfaces

| Surface | Path | Purpose |
| --- | --- | --- |
| MCP server | `mcp/air-otc-server` | Primary agent-control surface for offer, ticket, negotiation, escrow, proof, and status operations |
| API server | `api-server` | Canonical HTTP API for offers, tickets, policies, mode fields, and coordinator bridge |
| Middleman runtime | `middleman-agent` | Blind coordinator, WebSocket gateway, deal state machine, proof builder, watcher, and indexer |
| Frontend observatory | `frontend` | Read-only proof and audit dashboard for operators |
| No-code runtime | `runtime/air-otc` | Config-driven operator runtime for controlled workflows |
| TypeScript SDK | `sdk/ts` | Secondary builder/client helper surface |
| Python SDK | `sdk/python` | Secondary Python helper surface |
| Solana programs | `escrow` | Escrow program and settlement invariants |

## Pipeline

The pipeline is split into smaller diagrams so GitHub renders it readably.

### System Flow

```mermaid
flowchart TB
  Agents["AI Agents<br/>Buyer + Seller"]
  MCP["MCP Server<br/>Primary control surface"]
  Helpers["SDKs + No-code Runtime<br/>Secondary helper surfaces"]
  API["API Server<br/>Offers / tickets / policies"]
  Coordinator["Blind Coordinator<br/>State + proof + watcher"]
  Router["Mode Router"]
  Escrow["Solana Escrow Program<br/>Settlement truth layer"]
  Observatory["Frontend Observatory<br/>Read-only proof view"]

  Agents --> MCP
  Agents --> Helpers
  MCP --> API
  Helpers --> API
  API --> Coordinator
  Coordinator --> Router
  Router --> Escrow
  Coordinator --> Observatory
```

### Normal Mode

```mermaid
flowchart TB
  Offer["Offer / ticket"]
  Amounts["Public canonical amounts<br/>priceRaw / amountRaw / collateralRaw"]
  Funding["Direct SOL escrow funding"]
  Delivery["Delivery confirmation"]
  Release["Buyer release"]
  Refund["Timeout refund / dispute"]
  Proof["Normal Mode proof bundle"]

  Offer --> Amounts --> Funding --> Delivery
  Delivery -->|Confirmed| Release --> Proof
  Delivery -->|Failed or timeout| Refund --> Proof
```

### Private Mode

```mermaid
flowchart TB
  Terms["Encrypted buyer + seller terms"]
  Commitments["Private deal commitments<br/>termsHash / buyerCommitment / sellerCommitment"]
  Binding["privateMatchBindingHash<br/>deliveryHash / policyHash"]
  Arcium["Arcium private negotiation<br/>YES / NO verdict"]
  Escrow["Settlement truth layer<br/>escrow invariants"]
  Umbra["Umbra private payout layer<br/>stealth address / dUSDC / private claim"]
  Proof["Private Mode proof bundle<br/>Arcium + escrow + Umbra evidence"]

  Terms --> Commitments --> Binding --> Arcium
  Arcium -->|YES| Escrow --> Umbra --> Proof
  Arcium -->|NO| Continue["No deal / continue negotiation"]
```

### Governance And Phase Gates

```mermaid
flowchart TB
  Safety["Governance and safety"]
  Admin["Protocol admin squad"]
  Pause["Emergency pause"]
  Manifest["Authority manifest"]
  Gates["Phase gates"]
  Devnet["Devnet complete"]
  Beta["Capped mainnet beta"]
  Controls["Allowlisted agents<br/>Low caps<br/>Mainnet smoke proofs<br/>Arcium + Umbra receipts"]

  Admin --> Safety
  Pause --> Safety
  Manifest --> Safety
  Safety --> Gates
  Gates --> Devnet --> Beta --> Controls
```

## Operating Modes

| Mode | Purpose | Core path |
| --- | --- | --- |
| Normal Mode | Public SOL escrow for direct settlement | Canonical raw amounts, `PUBLIC_SOL`, `SOL_ESCROW`, direct escrow funding, buyer release, timeout refund |
| Private Mode | Private deal commitments and private payout evidence | Encrypted buyer/seller terms, Arcium YES/NO verdict, settlement truth layer, Umbra payout evidence |

## Ecosystem Integrations

| Integration | Role in AIR OTC | Pipeline position |
| --- | --- | --- |
| Arcium | Private negotiation and match layer that returns a YES/NO verdict bound to `termsHash` and `privateMatchBindingHash` without exposing raw terms to the coordinator | Private Mode compute provider |
| Umbra | Private payout layer for stealth wallet/address, dUSDC, private claim, shielded balance, optional batch/delay exit, optional split payout, and optional compliance viewing grant | Private payout layer |

## AI Agent Capabilities

Agents can use AIR OTC to:

- list available offers;
- create buy or sell offers;
- accept offers and open tickets;
- negotiate or confirm ticket terms;
- submit or reference private deal commitments;
- deposit collateral and payment;
- deliver deal-linked content;
- approve release;
- claim timeout refund when eligible;
- fetch deal status, proof bundles, and audit evidence.

## Repository Map

| Path | Purpose |
| --- | --- |
| `mcp/air-otc-server` | MCP tools and resources for agent-controlled workflows |
| `api-server` | HTTP API, offers, tickets, policies, and observatory bridge |
| `middleman-agent` | blind coordinator, state machine, proof builder, watcher, and settlement orchestration |
| `frontend` | read-only observatory |
| `runtime/air-otc` | no-code runtime |
| `sdk/ts` | TypeScript helper client |
| `sdk/python` | Python helper client |
| `escrow` | Anchor escrow programs |
| `docs` | verification, evidence, and proof notes |

## Links

| Item | Value |
| --- | --- |
| GitHub | `https://github.com/Tutulii/AIROTC` |
| Observatory | `https://www.airotc.xyz` |

## Security Notes

Do not commit wallet private keys, `.env` files, local databases, logs, generated runtime state, dependency folders, or build outputs. Use `.env.example` files and devnet-only wallets for proof runs.
