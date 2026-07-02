# AIR OTC Whitepaper

Last updated: 2026-07-02

## Abstract

AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

The system is designed for autonomous buyer and seller agents that need a controlled settlement workflow: offer creation, ticket negotiation, escrow, delivery confirmation, release approval, refund/dispute handling, private payout evidence, and operator-readable audit trails.

AIR OTC is now documented as an MCP-first architecture. SDK and no-code surfaces remain useful helper interfaces, but the primary product direction is to improve the MCP control surface for agent operation before expanding heavier SDK and CLI workflows.

## 1. Problem

AI agents can discover opportunities, hold wallets, and negotiate. They still need a settlement layer that can:

- encode private OTC terms as commitments;
- hold funds in escrow;
- enforce release and timeout/refund paths;
- keep raw sensitive terms away from the coordinator;
- produce audit evidence for operators;
- support private payout evidence where wallet linkage should be reduced.

Without this layer, agent commerce remains trapped between manual OTC operations and fully public transaction flows.

## 2. Product Model

AIR OTC has four practical product surfaces:

| Surface | Role |
| --- | --- |
| MCP server | Primary agent-control surface for autonomous workflows |
| API server + middleman runtime | Offers, tickets, policies, state machine, proof builder, watcher, and bridge logic |
| Frontend observatory | Read-only proof, audit, and market visibility |
| SDKs / no-code runtime | Secondary helper surfaces for builders and operators |

The frontend observes. The MCP server and backend workflow control execution.

## 3. Settlement Model

### Normal Mode

Normal Mode is the direct public escrow route.

It uses:

- `privacyTier: PUBLIC`;
- `settlementRail: SOL_ESCROW`;
- canonical raw amounts such as `priceRaw`, `amountRaw`, and `collateralRaw`;
- direct escrow funding;
- buyer release or timeout refund;
- normal proof bundle and escrow transaction signatures.

### Private Mode

Private Mode is the commitment-based route for sensitive deals.

It uses:

- encrypted buyer terms;
- encrypted seller terms;
- `termsHash`;
- `buyerCommitment`;
- `sellerCommitment`;
- `privateMatchBindingHash`;
- `deliveryHash` and `policyHash`;
- Arcium private negotiation and match verdict;
- Solana escrow invariants;
- Umbra private payout evidence.

The coordinator should see hashes and state signals, not raw private terms.

## 4. Ecosystem Integrations

AIR OTC currently presents only two ecosystem integrations in the current public architecture:

| Integration | Function |
| --- | --- |
| Arcium | Private negotiation and match logic. The expected output is a YES/NO verdict bound to `termsHash` and `privateMatchBindingHash`. |
| Umbra | Private payout layer using stealth wallet/address, dUSDC, private claim, shielded balance, optional batch/delay exit, optional split payout, and optional compliance viewing grant. |

## 5. Governance And Safety

AIR OTC is phase-gated before any serious production claim:

1. Production contract.
2. Financial correctness.
3. Agent guardrails.
4. Arcium private negotiation.
5. Umbra stealth dUSDC payout.
6. Batch/delay privacy hardening.
7. Capped mainnet beta.

The capped beta requires allowlisted agents, low caps, mainnet smoke proofs, Arcium + Umbra receipts, and emergency pause proof.

## 6. Target Users

- AI agent operators running autonomous buyer and seller agents.
- Digital asset teams and protocols that need private OTC settlement.
- OTC desks and marketplace operators that need agent-driven escrow automation.
- Institutional and enterprise teams that need governance controls, compliance visibility, and audit discipline.

## 7. What AIR OTC Should Claim Publicly

AIR OTC should be presented as:

- a private OTC settlement layer for AI agents;
- MCP-first in current product direction;
- capable of public Normal Mode escrow;
- designed for private commitment-based settlement using Arcium and Umbra;
- phase-gated before capped mainnet beta.

AIR OTC should not describe removed integrations as active product dependencies in current public docs.

## 8. Read Next

- [README.md](/Users/tutul/Downloads/AIR OTC/README.md)
- [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
