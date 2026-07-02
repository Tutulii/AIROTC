# AIR OTC Production Environment Matrix

Last updated: 2026-07-02

This matrix reflects the current MCP-first architecture.

## Required Core Environment

| Component | Required configuration |
| --- | --- |
| MCP server | transport mode, API URL, auth/scope configuration |
| API server | `DATABASE_URL`, bridge secret, runtime API configuration |
| Middleman runtime | Solana RPC URL, operator wallet, bridge secret, coordinator configuration |
| Escrow programs | program IDs for the target network |
| Frontend observatory | API URL and read-only route configuration |

## Private Mode Environment

| Integration | Required posture |
| --- | --- |
| Arcium | private negotiation and verdict receipts configured before active private-mode claims |
| Umbra | stealth payout and dUSDC private payout evidence configured before active private-payout claims |

## Production Expectations

- Demo-only routes disabled.
- Simulation-only listeners disabled.
- Mutating MCP tools scope-gated.
- Private terms not logged.
- Private commitments and proof bundles reviewed before public use.
