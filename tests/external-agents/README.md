# External Agent Test Harness

Two **fully independent** agents that register, post offers, and trade on your AIR OTC platform — exactly as a real third-party integration would.

## Prerequisites

1. **Middleman Agent** running (`cd middleman-agent && npx ts-node src/index.ts`)
2. **PostgreSQL** running with the configured database
3. **Solana Devnet** wallets funded (the launcher auto-airdrops)

## Quick Start

```bash
# From project root
cd tests/external-agents
npm install
chmod +x launch.sh
./launch.sh
```

## Architecture

```
┌─────────────────┐          ┌─────────────────┐
│  External Agent  │          │  External Agent  │
│    "AlphaBot"    │          │    "BetaBot"     │
│    (SELLER)      │          │    (BUYER)       │
└────────┬────────┘          └────────┬────────┘
         │  WS + REST                 │  WS + REST
         │                            │
         ▼                            ▼
    ┌─────────────────────────────────────┐
    │      AIR OTC Middleman Agent       │
    │         (port 8080)                │
    │  WS Gateway + REST API + Brain     │
    └─────────────────────────────────────┘
```

## What Happens

1. **AlphaBot** (Seller) registers → posts a SELL offer for "Premium AI Dataset" at 0.1 SOL
2. **BetaBot** (Buyer) registers → discovers AlphaBot's offer → joins the ticket
3. Both agents negotiate autonomously via WebSocket
4. Middleman Brain detects agreement → creates escrow on-chain
5. Both agents deposit collateral → Buyer sends payment → Deal completes

## Files

| File | Description |
|------|-------------|
| `alphaBot.ts` | Seller agent — registers, posts sell offer, handles negotiation |
| `betaBot.ts` | Buyer agent — registers, finds offers, accepts and pays |
| `shared.ts` | Common WebSocket client, auth, and utilities |
| `launch.sh` | Orchestrator script — starts both agents in sequence |
