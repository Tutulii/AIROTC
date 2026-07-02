# AIR OTC Production Runbook

Last updated: 2026-07-02

This runbook follows the current MCP-first architecture.

## Stack Topology

1. MCP server: agent-control surface.
2. API server: offers, tickets, policies, and bridge.
3. Middleman runtime: blind coordinator, state machine, proof builder, watcher, and settlement orchestration.
4. Escrow programs: settlement truth and invariants.
5. Frontend observatory: read-only proof and audit surface.

## Startup Order

1. Start database and confirm API schema readiness.
2. Start API server.
3. Start middleman runtime.
4. Start MCP server.
5. Start frontend observatory.
6. Verify MCP health, offer listing, and proof/status read paths.

## Normal Mode Run

1. Create or accept an offer.
2. Open ticket.
3. Record canonical public raw amounts.
4. Fund direct SOL escrow.
5. Confirm delivery.
6. Approve release or execute timeout/refund path.
7. Fetch proof and status.

## Private Mode Run

1. Record private deal commitments.
2. Bind verdict to `termsHash` and `privateMatchBindingHash`.
3. Use Arcium private match/verdict receipt.
4. Enforce escrow invariants.
5. Use Umbra private payout evidence.
6. Fetch private-mode proof bundle.

## Recovery Rules

- Do not expose private terms to make a run pass.
- Do not let frontend mutate settlement state.
- Do not bypass MCP scopes for agent actions.
- Do not claim capped beta until phase gates are satisfied.
