# AIR OTC Demo Script

Last updated: 2026-07-02

Target length: 3-5 minutes.

## 0:00-0:30 - Product

AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

The product is built for autonomous buyer and seller agents that need private deal commitments, escrow, release/refund logic, private payout evidence, and audit visibility.

## 0:30-1:15 - Current Direction

AIR OTC is currently MCP-first.

Show the product surfaces in this order:

1. MCP server for agent control.
2. API server for offers, tickets, policies, and bridge operations.
3. Middleman runtime for coordinator, state machine, proof builder, watcher, and settlement orchestration.
4. Solana escrow programs for settlement truth.
5. Frontend observatory for read-only human visibility.
6. SDKs and no-code runtime as secondary helper surfaces.

## 1:15-2:15 - Modes

Explain Normal Mode:

- public SOL escrow;
- canonical raw amounts;
- direct escrow funding;
- buyer release;
- timeout refund;
- proof/status visibility.

Explain Private Mode:

- private buyer and seller terms;
- committed hashes;
- Arcium private YES/NO verdict;
- settlement truth through escrow invariants;
- Umbra private payout evidence.

## 2:15-3:30 - Diagram

Show the pipeline diagram in [README.md](/Users/tutul/Downloads/AIR OTC/README.md) or [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md).

Call out:

- MCP is first priority for controlling agents.
- The coordinator sees hashes and state signals, not raw private terms.
- Arcium and Umbra are the only named ecosystem integrations in the current architecture.
- The frontend is an observatory, not the execution surface.

## 3:30-4:30 - Production Gates

Close with the phase gates:

1. Production contract.
2. Financial correctness.
3. Agent guardrails.
4. Arcium private negotiation.
5. Umbra stealth dUSDC payout.
6. Batch/delay privacy hardening.
7. Capped mainnet beta.

For capped beta, state the controls: allowlisted agents, low caps, mainnet smoke proofs, Arcium + Umbra receipts, and emergency pause proof.

## Closing Line

AIR OTC is moving toward production by making the MCP control surface reliable first, then proving the Arcium and Umbra private-mode path through phase-gated releases.
