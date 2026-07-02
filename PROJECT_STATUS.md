# AIR OTC Project Status

Last updated: 2026-07-02

This file is the current public status snapshot for AIR OTC after the architecture change. It intentionally follows the new MCP-first diagram and does not use older integration docs as the product source of truth.

## Current Product Shape

AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

The current product priority is:

1. **MCP-first agent control** through `mcp/air-otc-server`.
2. **API server** for offers, tickets, policies, canonical amounts, mode fields, and bridge operations.
3. **Blind coordinator** in `middleman-agent` for state, proof, watcher, and settlement orchestration.
4. **Solana escrow programs** for settlement truth and invariants.
5. **Frontend observatory** for read-only proof and audit visibility.
6. **SDK and no-code runtime surfaces** as secondary helper surfaces.

## Current Operating Modes

| Mode | Current role |
| --- | --- |
| Normal Mode | Public SOL escrow path with canonical raw amounts, direct escrow funding, buyer release, timeout refund, and proof/status visibility |
| Private Mode | Commitment-based private route designed around Arcium private verdicts and Umbra private payout evidence |

## Current Ecosystem Scope

| Integration | Current product role |
| --- | --- |
| Arcium | Private negotiation and match verdict layer for Private Mode |
| Umbra | Private payout evidence layer for stealth address, dUSDC, private claim, shielded balance, optional batch/delay exit, optional split payout, and optional compliance viewing grant |

Other previously explored integrations should be treated as historical unless they are reintroduced into the current architecture and docs.

## Product Surfaces

| Surface | Path | Status |
| --- | --- | --- |
| MCP server | `mcp/air-otc-server` | Primary surface to improve first |
| API server | `api-server` | Core offer/ticket/policy and bridge API |
| Middleman runtime | `middleman-agent` | Coordinator, state machine, proof builder, watcher, and settlement orchestration |
| Escrow programs | `escrow` | Settlement truth and invariants |
| Frontend observatory | `frontend` | Read-only human proof/audit view |
| No-code runtime | `runtime/air-otc` | Secondary operator helper |
| TypeScript SDK | `sdk/ts` | Secondary builder helper |
| Python SDK | `sdk/python` | Secondary builder helper |

## What Is Operationally Important Now

- MCP must become the easiest and safest way for agents to drive AIR OTC.
- Mutating MCP operations should remain scope-gated.
- MCP should expose status and proof reads without leaking private keys or raw private terms.
- Normal Mode should remain simple and explicit: public raw amounts, public SOL escrow, buyer release, timeout refund.
- Private Mode should be represented as commitments and receipts, not plaintext coordinator knowledge.
- Public docs should name only Arcium and Umbra as current ecosystem integrations.

## Phase Gates

AIR OTC should progress through these gates before broad production claims:

1. Production contract.
2. Financial correctness.
3. Agent guardrails.
4. Arcium private negotiation.
5. Umbra stealth dUSDC payout.
6. Batch/delay privacy hardening.
7. Capped mainnet beta.

The capped beta requires:

- allowlisted agents;
- low caps;
- mainnet smoke proofs;
- Arcium + Umbra receipts;
- emergency pause proof.

## Current Public Claim

The current clean public claim is:

> AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

## Current Documentation To Read First

1. [README.md](/Users/tutul/Downloads/AIR OTC/README.md)
2. [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
3. [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
4. [docs/PRODUCTION_ROADMAP_DIAGRAM.md](/Users/tutul/Downloads/AIR OTC/docs/PRODUCTION_ROADMAP_DIAGRAM.md)
5. [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)

## Historical Material

Some older packages, test fixtures, and proof files may still exist in the repository. They should not be used as the current AIR OTC architecture unless they are explicitly restored to the active product diagram and public documentation.
