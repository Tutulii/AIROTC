# AIR OTC Production Roadmap Diagram

Last updated: 2026-07-02

This diagram reflects the current MCP-first architecture and the updated integration scope. Current public roadmap diagrams should only name Arcium and Umbra as ecosystem integrations.

## Roadmap Flow

```mermaid
flowchart TB
  A["AI Agents"] --> A1["Buyer Agent"]
  A --> A2["Seller Agent"]
  A1 --> B["AIR OTC Interfaces"]
  A2 --> B
  B --> B1["TypeScript SDK"]
  B --> B2["Python SDK"]
  B --> B3["MCP Server"]
  B --> B4["No-code Runtime"]
  B --> B5["Frontend Observatory"]
  B1 --> C["API Server"]
  B2 --> C
  B3 --> C
  B4 --> C
  B5 --> C
  C --> C1["Offers / Tickets / Policies"]
  C --> C2["Public Mode Canonical Amounts"]
  C2 --> C2a["priceRaw / amountRaw / collateralRaw<br/>Normal Mode Only"]
  C --> C3["Private Deal Commitments"]
  C3 --> C3a["termsHash"]
  C3 --> C3b["buyerCommitment"]
  C3 --> C3c["sellerCommitment"]
  C3 --> C3d["privateMatchBindingHash"]
  C3 --> C3e["deliveryHash / policyHash"]
  C --> C4["Mode Fields"]
  C4 --> C4a["privacyTier: PUBLIC / PRIVATE"]
  C4 --> C4b["settlementRail: SOL_ESCROW / UMBRA_dUSDC"]
  C4 --> C4c["computeProvider: ARCIUM"]
  C --> C5["Prisma DB + Deterministic Migrations"]
  C --> D["Signed Bridge To Blind Coordinator"]
  D --> E["Blind Coordinator"]
  E --> E4["Deal State Machine"]
  E --> E5["Proof Builder"]
  E --> E6["Watcher / Indexer"]
  E --> E7["Sees Only Hashes + State Signals"]
  E4 --> F["Mode Router"]
  F --> G["Normal Mode"]
  G --> G1["PUBLIC_SOL"]
  G --> G2["SOL_ESCROW"]
  G --> G3["Direct Escrow Funding"]
  G --> G4["Buyer Release Or Timeout Refund"]
  F --> H["Private Mode"]
  H --> H1["Encrypted Buyer Terms"]
  H --> H2["Encrypted Seller Terms"]
  H --> H3["Arcium Private Negotiation / Match"]
  H3 --> H3a["YES / NO Verdict Only"]
  H3a -->|NO| X["No Deal / Continue Negotiation"]
  H3a -->|YES| I["Settlement Truth Layer"]
  G --> I
  I --> I1["Solana Escrow Program"]
  I --> I2["Escrow Invariants"]
  I --> J["Delivery Confirmation"]
  J -->|Confirmed| K["Release Approved"]
  J -->|Failed / Timeout| R["Refund / Dispute"]
  K --> P["Private Payout Layer"]
  P --> P1["Umbra Stealth Wallet / Address"]
  P1 --> P2["Umbra dUSDC"]
  P2 --> P3["Private Claim"]
  P3 --> P4["Shielded dUSDC Balance"]
  E5 --> Q["Proof / Audit Layer"]
  Q --> Q1["Normal Mode Proof Bundle"]
  Q --> Q2["Private Mode Proof Bundle"]
  Q --> Q3["Arcium YES / NO Verdict Receipt"]
  Q --> Q4["Escrow Tx Signatures"]
  Q --> Q5["Umbra Stealth Payout Evidence"]
  Q --> Q6["Invariant Verdicts"]
  Q --> B5
```

## Phase Gates

```mermaid
flowchart LR
  M["Phase Gates"] --> M1["Phase 1: Production Contract"]
  M --> M2["Phase 2: Financial Correctness"]
  M --> M3["Phase 3: Agent Guardrails"]
  M --> M4["Phase 4: Arcium Private Negotiation"]
  M --> M5["Phase 5: Umbra Stealth dUSDC Payout"]
  M --> M6["Phase 6: Batch / Delay Privacy Hardening"]
  M --> M7["Phase 7: Capped Mainnet Beta"]
  M1 --> N["Devnet Complete"]
  M2 --> N
  M3 --> N
  M4 --> N
  M5 --> N
  N --> O["Capped Mainnet Beta"]
  O --> O1["Allowlisted Agents"]
  O --> O2["Low Caps"]
  O --> O3["Mainnet Smoke Proofs"]
  O --> O4["Arcium + Umbra Receipts"]
  O --> O5["Emergency Pause Proof"]
```

## Claim Boundary

The roadmap supports a production-shaped claim only after the phase gates are satisfied. The current public docs should frame AIR OTC as MCP-first, private OTC settlement for agents, with Arcium and Umbra as the named private-mode integrations.
