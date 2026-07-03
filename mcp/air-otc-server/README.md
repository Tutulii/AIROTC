# AIR OTC MCP Server

Scoped MCP-compatible JSON-RPC server for AIR OTC agents and operators.

It is an interface layer, not settlement consensus. It must not be described as making AIR OTC fully trustless.

## Transports

```bash
cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm install
npm run build

# stdio, default for local agents
node dist/index.js

# HTTP JSON-RPC
node dist/index.js --http
```

HTTP listens on `AIR_OTC_MCP_PORT` or `8787` at `/mcp`.

## Environment

```bash
AIR_OTC_API_URL=http://localhost:3000
AIR_OTC_MIDDLEMAN_URL=http://localhost:8080
AIR_OTC_WS_URL=ws://localhost:8080
AIR_OTC_API_WS_URL=ws://localhost:3000
AIR_OTC_RPC_URL=https://api.devnet.solana.com
AIR_OTC_TS_SDK_PATH="/Users/tutul/Downloads/AIR OTC/sdk/ts/dist/index.mjs"

# Optional API auth forwarded to AIR OTC services
AIR_OTC_API_KEY=

# Optional operator secret used by SPORT admin MCP tools when calling API admin endpoints
AIR_OTC_TXLINE_ADMIN_TOKEN=

# Required only for PER run tools
AIR_OTC_WALLET_PRIVATE_KEY=

# Optional MCP auth and scopes. Generate hosted agent tokens at /settings/token.
AIR_OTC_MCP_TOKEN=airotc_sk_replace_me
AIR_OTC_MCP_SCOPES=offers:read,offers:write,deals:read,dm:read,dm:write,per:run,proofs:read,vault:read,umbra:read

# Optional multi-token auth. Each entry can have its own scope set.
AIR_OTC_MCP_TOKENS_JSON='[
  {
    "name": "trade-agent",
    "token": "mcp_manus_replace_me",
    "scopes": ["offers:read", "offers:write", "deals:read", "dm:read", "dm:write", "per:run", "proofs:read", "vault:read", "umbra:read"],
    "wallets": ["9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F"]
  },
  {
    "name": "sport-operator",
    "token": "mcp_sport_operator_replace_me",
    "scopes": ["offers:read", "offers:write", "deals:read", "sport:admin"]
  }
]'

# Optional hosted-MCP delegated wallet mode.
# Valid hosted MCP tokens may delegate calls for any explicit wallet without
# receiving raw wallet private keys.
AIR_OTC_MCP_DELEGATION_TOKEN=
```

Mutating tools require a bearer token with the required scope. Prefer `Authorization: Bearer <token>` or `X-AIROTC-MCP-Token`; the `authToken` tool argument remains only as a fallback for older clients.
Generated `airotc_sk` hosted tokens verify as full trade-agent tokens. The signing wallet is used as the default wallet when a tool omits `wallet`; it is not a hard binding for explicit wallet parameters.
`AIR_OTC_MCP_TOKENS_JSON` supports multiple independent bearer tokens, each with its own scopes and optional wallet binding, without replacing the legacy `AIR_OTC_MCP_TOKEN`.
SPORT ingestion and manual settlement controls require the operator-only `sport:admin` scope. Normal hosted trade-agent tokens intentionally do not include this scope.

## Tools

- `airotc_health`
- `airotc_list_events`
- `airotc_get_live_config`
- `airotc_get_agent_events`
- `airotc_ack_agent_event`
- `airotc_ack_agent_events`
- `airotc_list_offers`
- `airotc_sport_list_matches`
- `airotc_sport_get_fixture`
- `airotc_sport_create_offer`
- `airotc_sport_accept_offer`
- `airotc_sport_get_settlement_status`
- `airotc_sport_ingestion_status`
- `airotc_sport_start_ingestion` (`sport:admin`)
- `airotc_sport_stop_ingestion` (`sport:admin`)
- `airotc_sport_run_settlement_once` (`sport:admin`)
- `airotc_create_offer`
- `airotc_accept_offer`
- `airotc_list_wallet_tickets`
- `airotc_get_ticket_messages`
- `airotc_send_ticket_message`
- `airotc_send_dm`
- `airotc_list_dm_inbox`
- `airotc_get_dm_conversation`
- `airotc_get_dm_unread`
- `airotc_get_deal_dms`
- `airotc_mark_dm_read`
- `airotc_mark_dm_conversation_read`
- `airotc_delete_dm`
- `airotc_publish_dm_encryption_key`
- `airotc_get_dm_encryption_key`
- `airotc_get_dm_file_info`
- `airotc_run_per_buyer_flow`
- `airotc_run_per_seller_flow`
- `airotc_get_deal_status`
- `airotc_get_proof_bundle`
- `airotc_vault_status`
- `airotc_umbra_lifecycle_status`

## Resources

- `airotc://deals/{ticketId}`
- `airotc://proofs/{ticketId}`
- `airotc://vault/status`

## Security Boundary

- Never returns private keys.
- Does not expose plaintext PER terms.
- Does not unseal private backend metadata.
- PER workflow tools use `AIR_OTC_WALLET_PRIVATE_KEY` inside the local process only.
- Scope failures are explicit, for example `mcp_scope_missing:offers:write`.

## Verification

```bash
cd "/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server"
npm run typecheck
npm run build
npm test
npm audit --audit-level=moderate
```

The current package tree has zero npm audit findings at `moderate` or higher.
