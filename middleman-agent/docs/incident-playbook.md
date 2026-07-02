# AIR OTC Incident Playbook

Last updated: 2026-07-02

Use this playbook when a current MCP-first proof, demo, or run goes red.

## First Response

1. Capture the failing command, timestamp, and log artifact.
2. Classify the failure as MCP, API, coordinator, escrow, frontend, Arcium, Umbra, Solana RPC, database, or unknown.
3. Do not change code until the failing boundary is identified.

## Triage

| Failure area | First check |
| --- | --- |
| MCP | health, scopes, auth, tool payload, API reachability |
| API | schema readiness, bridge secret, offer/ticket route logs |
| Coordinator | WebSocket gateway, state machine, proof builder, watcher |
| Escrow | program ID, transaction signature, release/refund invariant |
| Frontend | read-only status, API URL, stale cached data |
| Arcium | private verdict receipt availability |
| Umbra | private payout evidence availability |

## Recovery Rules

- Keep private terms out of logs and public responses.
- Do not bypass MCP scopes to recover a failed run.
- Do not use frontend writes to patch settlement state.
- Do not call an incident resolved until the failing gate is green again.
