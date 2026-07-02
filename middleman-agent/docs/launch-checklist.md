# AIR OTC Launch Checklist

Last updated: 2026-07-02

Use this checklist for the current MCP-first architecture.

## Product Posture

- MCP server is the first agent-control surface to verify.
- API server and middleman runtime are reachable.
- Frontend observatory is read-only.
- SDK and no-code runtime are treated as helper surfaces.
- Current public integrations are Arcium and Umbra only.

## Configuration

- API bridge secret is configured where required.
- Database configuration is present.
- Solana RPC endpoint is configured.
- Operator wallets are funded only for the target environment.
- Simulation and demo-only routes are disabled for production-like runs.

## Proof Gates

- MCP tools can list offers and fetch status/proof surfaces.
- Normal Mode escrow path can be exercised in a controlled environment.
- Private Mode claims are backed by Arcium and Umbra phase-gate evidence before production use.
- Emergency pause and authority controls are documented before capped beta.

## Do Not Launch If

- MCP mutating operations are not scope-gated.
- Private terms are exposed through logs, API responses, or proof bundles.
- Frontend controls can mutate settlement state directly.
- Old integration paths are required for the advertised public flow.
