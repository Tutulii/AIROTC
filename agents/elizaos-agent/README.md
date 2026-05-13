# AIR OTC ElizaOS Agents

Real external **ElizaOS** buyer and seller agents for the AIR OTC flagship demo.

These agents:
- use the official [`@elizaos/core`](https://www.npmjs.com/package/@elizaos/core) runtime
- join AIR OTC through the **public** [`@agentotc/sdk`](</Users/tutul/Downloads/AIR OTC/sdk/ts>)
- support both **ER** and **PER**
- use **E2E encrypted DM** for delivery
- complete the real escrow pipeline and trigger live **Torque** post-settlement rewards

## What is in here

```text
agents/elizaos-agent/
├── index.ts                    # Boots the official ElizaOS runtime
├── character.ts                # Shared buyer/seller character template
├── providers/                  # Context injected into LLM decisions
├── plugins/                    # ElizaOS plugin registration
├── services/
│   ├── meridianSDK.ts          # Public SDK wrapper (@agentotc/sdk)
│   ├── groqModel.ts            # Optional LLM provider registration
│   └── dealTracker.ts          # Deterministic agent state tracker
├── proof/perFlagshipProof.ts   # One-command live PER proof
└── package.json
```

## Runtime model

The agents are **LLM-driven**, but not LLM-custodial.

- the LLM chooses the next safe SDK step
- deterministic SDK methods execute money-critical operations:
  - offer creation / acceptance
  - private agreement finalization
  - confidential funding
  - encrypted delivery
  - signed release confirmation

If no working model provider is configured, the agents fall back to the deterministic recommendation engine instead of stalling.

## Install

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
npm install
```

## Environment

Create `agents/elizaos-agent/.env.local` if you want to override local defaults.

Minimum useful variables:

```bash
GROQ_API_KEY=...
SELLER_PRIVATE_KEY=...
BUYER_PRIVATE_KEY=...
AIROTC_API_URL=http://localhost:3000
AIROTC_WS_URL=ws://localhost:8080
SOLANA_RPC_URL=https://api.devnet.solana.com
AIROTC_TRADE_ASSET=SOL
AIROTC_TRADE_ASSET_MINT=So11111111111111111111111111111111111111112
AIROTC_TRADE_AMOUNT=1
AIROTC_TRADE_PRICE_SOL=0.1
AIROTC_TRADE_COLLATERAL_SOL=0.02
ENCRYPTED_DELIVERY_PAYLOAD=ACCESS_TOKEN=ACCESS_TOKEN_12345
AIROTC_AGENT_LLM_PROVIDER=groq
```

Notes:
- buyer and seller can use separate keys through `BUYER_PRIVATE_KEY` and `SELLER_PRIVATE_KEY`
- `AIROTC_AGENT_LLM_PROVIDER=groq` keeps the demo runtime pinned to the intended provider
- if no valid model provider is available, the runtime still works through deterministic fallbacks

## Run modes

### Flagship PER seller

```bash
npm run seller
```

### Flagship PER buyer

```bash
npm run buyer
```

### Explicit aliases

```bash
npm run seller-private
npm run buyer-private
```

### ER / public flow

```bash
npm run seller-public
npm run buyer-public
```

## One-command live proof

This is the main judge-facing proof:

```bash
npm run proof:per
```

What it does:

1. boots a real seller ElizaOS agent
2. boots a real buyer ElizaOS agent
3. posts a live PER offer
4. accepts it through the public SDK
5. finalizes private terms via rollup methods
6. submits confidential funding
7. delivers credentials over encrypted DM
8. confirms private release
9. settles through the live escrow pipeline
10. verifies the post-settlement Torque sidecar path

## Latest live verification

The latest previously captured live Eliza proof in this workspace completed successfully on ticket `f5d8caae-1c9c-44cc-bbf0-48eb319254b8`.

The newer no-code runtime proof is tracked separately in:

- [runtime/air-otc/README.md](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/README.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)

## Honest capability statement

After the latest hardening pass, these agents can honestly claim:

- join AIR OTC through the public SDK
- browse and post offers
- accept and complete real **PER** trades end to end
- use encrypted DM for delivery
- run as real buyer and seller external agents from one shared codebase

They also support **ER**, but PER is the primary demo and proof path.

## Related docs

- Public SDK: [/Users/tutul/Downloads/AIR OTC/sdk/ts/README.md](</Users/tutul/Downloads/AIR OTC/sdk/ts/README.md>)
- PER proof launcher: [/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/proof/perFlagshipProof.ts](</Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/proof/perFlagshipProof.ts>)
- Frontend docs page: [/Users/tutul/Downloads/AIR OTC/frontend/app/docs/page.tsx](</Users/tutul/Downloads/AIR OTC/frontend/app/docs/page.tsx>)
