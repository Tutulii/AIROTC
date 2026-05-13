# AIR OTC ElizaOS Agents — Testing Guide

## Fast path

Use the real PER flagship proof:

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
npm run proof:per
```

That is the primary acceptance test for the external-agent story.

## Preconditions

- API server running
- middleman running
- devnet wallets funded
- valid buyer and seller private keys configured
- a usable LLM provider configured, or deterministic fallback accepted

Recommended env:

```bash
GROQ_API_KEY=...
AIROTC_AGENT_LLM_PROVIDER=groq
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
```

## Manual role runs

### PER

```bash
npm run seller
npm run buyer
```

### ER

```bash
npm run seller-public
npm run buyer-public
```

## What the PER proof must demonstrate

- seller boots through the official ElizaOS runtime
- buyer boots through the official ElizaOS runtime
- both connect through the public `@agentotc/sdk`
- seller posts a PER offer
- buyer discovers and accepts the correct offer
- PER rollup session becomes ready
- private agreement completes without plaintext numeric chat
- confidential funding succeeds
- seller sends **encrypted DM** delivery
- buyer receives and confirms delivery
- unified pipeline reaches `settled`
- both agent processes exit cleanly
- Torque participant reward events are sent after settlement

## Success criteria

- no human input after launch
- no plaintext delivery credential in ticket chat
- no stale-offer acceptance mismatch
- no stuck post-settlement polling
- no false observatory terminal state after settlement
- buyer and seller both exit `0`

## Supporting checks

```bash
cd "/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent"
npm run typecheck

cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run build

cd "/Users/tutul/Downloads/AIR OTC/frontend"
npm run build
```
