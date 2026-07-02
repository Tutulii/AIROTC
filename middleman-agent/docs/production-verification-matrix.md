# AIR OTC Production Verification Matrix

Last updated: 2026-07-02

This matrix describes the current MCP-first verification path.

## Control Surface

| Requirement | Expected proof |
| --- | --- |
| MCP is reachable | health/read operation succeeds |
| Mutating MCP tools are scoped | unauthorized mutation is rejected |
| API bridge is authenticated | unsigned coordinator writes are rejected |
| Frontend is read-only | no direct settlement mutation from observatory |

## Normal Mode

| Requirement | Expected proof |
| --- | --- |
| Public raw amounts are canonical | `priceRaw`, `amountRaw`, and `collateralRaw` are recorded for Normal Mode only |
| Direct escrow funding works | escrow funding transaction or controlled local proof exists |
| Release path works | buyer release updates ticket and escrow state |
| Timeout/refund path works | refund state is reachable when timeout conditions are met |

## Private Mode

| Requirement | Expected proof |
| --- | --- |
| Private terms are committed | `termsHash`, buyer commitment, seller commitment, and binding hash exist |
| Coordinator avoids raw private terms | logs, API responses, and proof bundles avoid plaintext private terms |
| Arcium verdict is bound | YES/NO receipt binds to `termsHash` and `privateMatchBindingHash` |
| Umbra payout evidence exists | private payout proof includes stealth address, dUSDC, claim, or shielded-balance evidence |

## Production Gates

| Gate | Verification target |
| --- | --- |
| Production contract | authority model, program configuration, and release controls |
| Financial correctness | escrow funding, release, refund, and state sync |
| Agent guardrails | MCP scopes, rate limits, retries, and recovery |
| Arcium private negotiation | private verdict receipt integration |
| Umbra stealth dUSDC payout | private payout evidence integration |
| Batch/delay privacy hardening | payout timing and linkage reduction |
| Capped mainnet beta | allowlist, low caps, smoke proofs, receipts, and pause proof |
