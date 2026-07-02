# AIR OTC Evidence Registry

Last updated: 2026-07-02

This registry maps the current public AIR OTC claims to the files that should be reviewed first. It follows the new MCP-first architecture and current diagram.

## Product Claims

| Claim | Source of truth | Verification approach |
| --- | --- | --- |
| AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md) | Human review |
| The current architecture is MCP-first | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md), [mcp/air-otc-server](/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server) | Repository structure + MCP package review |
| SDKs and no-code runtime are secondary helper surfaces | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md) | Human review |
| The frontend is an observatory, not the primary execution surface | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [frontend](/Users/tutul/Downloads/AIR OTC/frontend) | Frontend route review |

## Architecture Claims

| Claim | Source of truth | Verification approach |
| --- | --- | --- |
| Normal Mode uses public raw amounts and direct SOL escrow | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md), [escrow](/Users/tutul/Downloads/AIR OTC/escrow) | Code and diagram review |
| Private Mode uses private deal commitments and a private payout path | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md) | Diagram and model review |
| The coordinator should see hashes and state signals, not raw private terms | [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md), [middleman-agent](/Users/tutul/Downloads/AIR OTC/middleman-agent) | Coordinator implementation review |
| Settlement truth comes from the Solana escrow program and escrow invariants | [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md), [escrow](/Users/tutul/Downloads/AIR OTC/escrow) | Escrow program review |

## Ecosystem Integration Claims

| Integration | Current claim | Source of truth |
| --- | --- | --- |
| Arcium | Private negotiation and match verdict layer bound to committed terms | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md) |
| Umbra | Private payout evidence layer for stealth address, dUSDC, private claim, shielded balance, and optional privacy/compliance flows | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md) |

## MCP Claims

| Claim | Source of truth | Verification approach |
| --- | --- | --- |
| MCP is the first control surface being improved | [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md), [mcp/air-otc-server](/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server) | Package review |
| MCP should support offer, ticket, negotiation, escrow, proof, and status operations | [README.md](/Users/tutul/Downloads/AIR OTC/README.md), [mcp/air-otc-server/src/index.ts](/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server/src/index.ts) | Tool catalog/code review |
| Mutating MCP operations should be scope-gated | [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md), [mcp/air-otc-server/src/index.ts](/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server/src/index.ts) | Auth and scope review |

## Phase-Gate Claims

| Gate | Meaning |
| --- | --- |
| Production contract | Settlement program and authority model are ready for production hardening |
| Financial correctness | Escrow amounts, release, refund, and state synchronization are proven |
| Agent guardrails | Agent actions are scoped, rate-limited, and recoverable |
| Arcium private negotiation | Private verdict receipts are integrated into the settlement route |
| Umbra stealth dUSDC payout | Private payout evidence is integrated into the settlement route |
| Batch/delay privacy hardening | Payout timing and linkage protections are strengthened |
| Capped mainnet beta | Allowlisted, low-cap production test with smoke proofs and emergency controls |

## Historical Evidence Boundary

Older proof logs and package docs may remain in the repository. They should be treated as historical evidence unless the current README, architecture, whitepaper, and project status files also include them in the active architecture.
