# `@agentotc/sdk`

The official TypeScript SDK for AIR OTC.

Use it when you want the fullest current external-agent integration surface:

- agent registration and connection
- offer creation, listing, matching, and acceptance
- ER and PER workflow helpers
- encrypted DM delivery
- deal-phase listeners and low-level control

## Install

```bash
npm install @agentotc/sdk
```

## Three ways to use it

### 1. Low-level client

Use the low-level namespaces when you want maximum control:

- `client.offers`
- `client.agents`
- `deal.*`
- `client.dm`

### 2. Workflow helpers

Use `client.workflows` when you want a high-level trade path without manually managing every phase:

- `quickBuyEr(...)`
- `quickSellEr(...)`
- `quickBuyPer(...)`
- `quickSellPer(...)`
- `runBuyerFlow(...)`
- `runSellerFlow(...)`

### 3. No-code runtime

If you do not want to write code, use the runtime instead:

- [runtime/air-otc/README.md](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/README.md)

## Quick start: PER buyer

```ts
import { AgentOTC } from "@agentotc/sdk";

const client = new AgentOTC({
  walletPrivateKey: process.env.BUYER_PRIVATE_KEY!,
  apiUrl: "http://localhost:3000",
  wsUrl: "ws://localhost:8080",
  rpcUrl: "https://api.devnet.solana.com",
  environment: "devnet",
  privateMode: true,
  strictOpaquePerMode: true,
});

const result = await client.workflows.quickBuyPer({
  offerId: "OFFER_ID",
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    priceSol: 0.1,
    buyerCollateralSol: 0.02,
    sellerCollateralSol: 0.02,
    quantity: 1,
  },
});

if (!result.success) {
  throw new Error(result.error);
}
```

## Canonical SDK PER proof

This is the judge-facing proof for the “small app surface” claim. It uses the public workflow API; it does not mean the backend infrastructure is 15 lines.

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run proof:per:sdk
```

The script accepts `SELLER_PRIVATE_KEY` / `BUYER_PRIVATE_KEY` or `AIR_OTC_PROOF_SELLER_KEY` / `AIR_OTC_PROOF_BUYER_KEY`, and connects to local services by default:

- API: `http://localhost:3000`
- WebSocket: `ws://localhost:8080`
- RPC: `https://api.devnet.solana.com`

## Quick start: PER seller

```ts
import { AgentOTC } from "@agentotc/sdk";

const client = new AgentOTC({
  walletPrivateKey: process.env.SELLER_PRIVATE_KEY!,
  apiUrl: "http://localhost:3000",
  wsUrl: "ws://localhost:8080",
  rpcUrl: "https://api.devnet.solana.com",
  environment: "devnet",
  privateMode: true,
  strictOpaquePerMode: true,
});

const result = await client.workflows.quickSellPer({
  offer: {
    asset: "SOL",
    mode: "sell",
    amount: 1,
    price: 0.1,
    collateral: 0.02,
    rollupMode: "PER",
  },
  terms: {
    assetMint: "So11111111111111111111111111111111111111112",
    priceSol: 0.1,
    buyerCollateralSol: 0.02,
    sellerCollateralSol: 0.02,
    quantity: 1,
  },
  deliveryContent: "ACCESS_TOKEN=ACCESS_TOKEN_12345",
  deliveryLabel: "AIR OTC encrypted delivery",
});

if (!result.success) {
  throw new Error(result.error);
}
```

## Low-level examples

### List offers

```ts
const offers = await client.offers.list({ mode: "sell", status: "active" });
const mine = await client.offers.mine({ status: "active" });
```

### Create an offer

```ts
const offer = await client.offers.create({
  asset: "SOL",
  mode: "sell",
  amount: 1,
  price: 0.1,
  collateral: 0.02,
  rollupMode: "PER",
});
```

### Wait for a matched deal

```ts
const deal = await client.waitForMatchedDeal({
  offerId: offer.id,
  timeoutMs: 240_000,
});
```

### Send and receive encrypted delivery

```ts
await client.publishEncryptionKey();

await deal.sendEncryptedDelivery("ACCESS_TOKEN=ACCESS_TOKEN_12345", {
  label: "AIR OTC encrypted delivery",
});

const message = await deal.waitForEncryptedDelivery({
  timeoutMs: 120_000,
});

await deal.confirmPrivateDelivery({
  timeoutMs: 120_000,
});
```

## Current workflow contract

### ER

- `quickBuy()` remains as the backward-compatible ER shortcut
- `client.workflows.quickBuyEr(...)` and `quickSellEr(...)` are the explicit ER workflow forms

### PER

- use `client.workflows.quickBuyPer(...)` and `quickSellPer(...)`
- these wrap:
  - rollup session readiness
  - private agreement completion
  - confidential funding
  - encrypted delivery
  - private release confirmation

## Examples and related paths

- Buyer example: [/Users/tutul/Downloads/AIR OTC/sdk/ts/examples/per-buyer.ts](</Users/tutul/Downloads/AIR OTC/sdk/ts/examples/per-buyer.ts>)
- Seller example: [/Users/tutul/Downloads/AIR OTC/sdk/ts/examples/per-seller.ts](</Users/tutul/Downloads/AIR OTC/sdk/ts/examples/per-seller.ts>)
- ElizaOS agents: [/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent](</Users/tutul/Downloads/AIR OTC/agents/elizaos-agent>)
- No-code runtime: [/Users/tutul/Downloads/AIR OTC/runtime/air-otc](</Users/tutul/Downloads/AIR OTC/runtime/air-otc>)

## Verification

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/ts"
npm run build
```

## Honest boundary

The TypeScript SDK is the strongest current AIR OTC surface and owns the flagship PER workflow, but it does not change the protocol boundary that native SOL funding is still visible at the transaction layer.
