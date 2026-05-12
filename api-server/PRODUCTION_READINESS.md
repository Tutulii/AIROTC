# API Server Production Readiness

This document defines the API-side production contract for the `AIR OTC` marketplace and ticket surfaces.

## Core responsibilities

- create, list, and accept offers
- maintain matched tickets and chat surfaces
- bridge matched deals into `middleman-agent`
- preserve strict `PER` redaction guarantees after match

## Production assumptions

- `PER_STRICT_OPAQUE_MODE=true`
- `BRIDGE_SECRET` is set on both `api-server` and `middleman-agent`
- `ENABLE_DB_DIAGNOSTICS_ROUTE` stays unset or `false` in normal deployments
- `ENABLE_SIMULATION_ROUTES` stays unset or `false` in normal deployments
- `api-server` must never be the authoritative owner of final private PER terms after match
- matched `PER` tickets are conversation surfaces, not numeric truth sources

## Non-negotiable API rules

- accepting a `PER` offer must preserve `rollupMode=PER`
- the bridge to `/v1/deals/create-matched` must not forward plaintext `price` or `collateral` when strict PER is enabled
- matched-ticket reads and recent-deal reads must label strict PER terms as private/redacted
- free-text chat must not be treated as authoritative numeric agreement for PER
- wallet-signature authentication remains required for state-changing agent actions
- internal observatory bridge routes must reject unsigned traffic
- database diagnostics must stay opt-in, signed, and sanitized
- simulation/demo lifecycle routes must stay opt-in and disabled in production

## Deploy-time checklist

- Prisma schema is migrated and reachable
- `DATABASE_URL` is valid
- middleman bridge URL and auth secret are configured
- rate limiting is enabled
- ticket + offer controllers are serving healthily
- strict PER env is enabled

## API-side proof expectations

Run these before sign-off:

```bash
cd /Users/tutul/Downloads/AIR OTC/api-server
npm run typecheck
npx vitest run tests/encrypt_status_proxy.test.ts tests/internal_surfaces_security.test.ts tests/internal_bridge_auth.test.ts tests/per_marketplace_bridge.test.ts tests/per_ticket_redaction.test.ts tests/per_marketplace_offer_flow.test.ts
```

These prove:

- the API package compiles without importing `middleman-agent` sources across the package boundary
- unsigned internal bridge writes are rejected
- `/test-db` is disabled by default and never returns raw database rows
- `/v1/simulate` is disabled by default and only available in explicitly enabled demo environments
- confidential status is proxied over HTTP instead of importing `middleman-agent` runtime code
- strict PER bridge payloads redact `price` and `collateral`
- matched ticket/deal read surfaces stay redacted
- marketplace PER offer creation + accept flow preserves the intended contract

## Known boundaries

- the API server may expose public offer metadata before a match
- after a PER match, the API server must not pretend to own the final negotiated private numbers
- the actual final numeric agreement for PER happens through SDK rollup methods and private handoff proof

## Incident notes

If users report a private PER mismatch:

1. verify whether the mismatch is on a public pre-match offer view or a matched private ticket
2. verify that `rollupMode=PER` was preserved on accept
3. verify that bridge payloads redacted `price` / `collateral`
4. verify that the middleman/private SDK path, not chat parsing, set the final agreement
