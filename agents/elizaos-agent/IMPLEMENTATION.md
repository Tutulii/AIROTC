# AIROTC ElizaOS Agent — Implementation Summary

> Current runtime note:
> the shipped agent now uses the public `@agentotc/sdk` package as its external integration surface. Historical mentions of `MeridianClient` below refer to the internal runtime engine bundled into that SDK, not the preferred third-party integration API.

## ✅ What Was Built

A **fully autonomous ElizaOS agent** that connects to AIROTC and completes real OTC deals on Solana devnet. The agent is:

- ✅ **Real ElizaOS** — Uses the actual `@elizaos/core` framework, not a wrapper
- ✅ **Fully Autonomous** — Makes all decisions based on market conditions and constraints
- ✅ **Complete Deal Lifecycle** — Posts offer → accepts → negotiates → deposits → delivers → releases
- ✅ **Dual Role** — Runs as buyer or seller (CLI flag: `--role buyer` or `--role seller`)
- ✅ **Dual Mode** — Supports both ER (public) and PER (private) paths
- ✅ **Event-Driven** — Uses WebSocket to react to deal phase changes in real-time

## 📁 Directory Structure

```
agents/elizaos-agent/
├── index.ts                 ← Entry point (boots ElizaOS runtime)
├── character.ts             ← Agent personality and system instructions
├── package.json            ← Dependencies (@elizaos/core, @agentotc/sdk, Solana)
├── tsconfig.json           ← TypeScript config
├── .env                    ← Configuration template
├── README.md               ← User guide
├── TESTING.md              ← Test procedures
├── setup.sh                ← Quick setup script
│
├── actions/                ← 8 ElizaOS Actions
│   ├── postOffer.ts        ← POST_OFFER: seller posts offer
│   ├── browseOffers.ts     ← BROWSE_OFFERS: buyer finds offers
│   ├── acceptOffer.ts      ← ACCEPT_OFFER: buyer accepts offer
│   ├── negotiateTerms.ts   ← NEGOTIATE_TERMS: both confirm deal
│   ├── depositCollateral.ts← DEPOSIT_COLLATERAL: send funds to escrow
│   ├── confirmDelivery.ts  ← CONFIRM_DELIVERY: seller sends credentials
│   ├── approveRelease.ts   ← APPROVE_RELEASE: buyer confirms receipt
│   └── openDispute.ts      ← OPEN_DISPUTE: escalate if things go wrong
│
├── providers/              ← ElizaOS Providers (inject context into LLM calls)
│   └── airotcProvider.ts   ← Injects deal status, balance, offers into every LLM call
│
├── plugins/                ← ElizaOS Plugins (bundle actions + providers)
│   └── airotcPlugin.ts     ← Registers all 8 actions + 1 provider with runtime
│
└── services/               ← Core business logic (not ElizaOS specific)
    ├── meridianSDK.ts      ← Singleton wrapper around the public @agentotc/sdk client
    └── dealTracker.ts      ← Persists deal state across action invocations
```

## 🏗️ Architecture

### Layer 1: ElizaOS Runtime

- **Entry Point** (`index.ts`): Boots the ElizaOS `AgentRuntime`
- **Character** (`character.ts`): Personality, system prompt, examples
- **Plugin** (`airotcPlugin.ts`): Registers actions + providers

### Layer 2: Actions (8 Autonomous Operations)

Each action:
- Validates preconditions (role, deal phase)
- Executes business logic (via SDK)
- Returns a message for the LLM
- Updates deal state (via dealTracker)

```
Action Structure:
├── validate() — Can this action run now?
├── handler()  — Do the work
└── examples[] — Show the LLM how to invoke
```

### Layer 3: Context & State

- **Provider** (`airotcProvider.ts`): Injects current deal status into **every LLM call**
  - Deal phase, ticket ID, escrow address
  - Wallet balance, available offers
  - Constraints and next steps

- **Deal Tracker** (`dealTracker.ts`): Persists state across ElizaOS invocations
  - ElizaOS actions are **stateless**
  - Deal tracker holds state between calls
  - Survives agent restarts (optional persistence)

### Layer 4: SDK Integration

- **MeridianSDK Service** (`meridianSDK.ts`): Singleton wrapper
  - One `MeridianClient` per agent process
  - Initialized before ElizaOS boots
  - Reused by all 8 actions
  - Event listeners wired at init time

### Layer 5: External Services

- **MeridianClient**: Official SDK for AIROTC
  - `createOffer()`, `acceptOffer()`, `sendMessage()`, etc.
  - WebSocket connection to middleman
  - Emits events: `phase_changed`, `message`, `escrow_address`, `deal_complete`

## 🔄 Deal Lifecycle

### Seller Path

```
IDLE
  ↓ [POST_OFFER]
OFFER_POSTED (waiting for buyer)
  ↓ [buyer accepts]
MATCHED
  ↓ [NEGOTIATE_TERMS] - send agreement message
CONFIRMED
  ↓ [middleman creates escrow]
ESCROW_CREATED
  ↓ [both deposit collateral]
COLLATERAL_SENT
  ↓ [CONFIRM_DELIVERY] - send credentials
DELIVERY
  ↓ [buyer approves release]
COMPLETED ✅
```

### Buyer Path

```
IDLE
  ↓ [BROWSE_OFFERS] - find matching offer
MATCHED
  ↓ [ACCEPT_OFFER] - accept offer, get ticket
NEGOTIATING
  ↓ [NEGOTIATE_TERMS] - send agreement message
CONFIRMED
  ↓ [middleman creates escrow]
ESCROW_CREATED
  ↓ [DEPOSIT_COLLATERAL] - send collateral + payment
COLLATERAL_SENT
  ↓ [wait for delivery]
DELIVERY (received credentials)
  ↓ [APPROVE_RELEASE] - confirm receipt
COMPLETED ✅
```

## 🤖 Autonomous Decision Making

The LLM makes decisions based on:

1. **Current Deal Phase** (from provider context)
2. **Agent Role** (buyer or seller)
3. **Available Context** (balance, prices, offers, constraints)
4. **Character Instructions** (personality + system prompt)

**Example LLM reasoning:**

```
Provider says: "Phase: idle, Role: buyer, Available offers: 5"
Character says: "If phase is idle and role is buyer, scan for offers"
LLM decides: "Call BROWSE_OFFERS"

Provider says: "Phase: matched, Offer price 0.1, Max price 0.5"
Character says: "If price within budget, accept"
LLM decides: "Call ACCEPT_OFFER"

Provider says: "Phase: delivery, Delivery received: true"
Character says: "If delivery received, approve release"
LLM decides: "Call APPROVE_RELEASE"
```

## 📊 State Management

### Deal Tracker

Maintains a single `DealState` object:

```typescript
{
  ticketId: string | null,           // Unique deal ID
  offerId: string | null,             // Offer being considered
  phase: DealPhase,                   // Current lifecycle phase
  escrowAddress: string | null,       // Escrow PDA
  price: number | null,               // Deal price (SOL)
  collateral: number | null,          // Collateral amount
  counterparty: string | null,        // Other agent's wallet
  lastUpdated: number,                // Timestamp
  agreementScore?: number,            // Score from middleman
  depositConfirmedBuyer?: boolean,    // Deposit status
  depositConfirmedSeller?: boolean,   // Deposit status
  deliveryReceived?: boolean,         // Delivery status
}
```

### Event Flow

```
MeridianClient emits events
       ↓
index.ts event handlers update dealTracker
       ↓
ElizaOS provider reads dealTracker
       ↓
LLM gets full context
       ↓
LLM selects next action
       ↓
Action handler uses dealTracker + SDK
       ↓
Action updates dealTracker
       ↓
Loop continues...
```

## 🎯 Design Principles

### 1. No Guessed APIs

- Read actual ElizaOS source before implementing
- Use only methods that exist in `@elizaos/core`
- Import actual types, not custom shims

### 2. Singleton SDK

- One `MeridianClient` per process
- Initialized before ElizaOS boots
- Events wired at init time (not in actions)
- Reused by all 8 actions

### 3. Deal Tracker is Source of Truth

- Actions never derive phase from message history
- Always read from `dealTracker.get()`
- Provider uses tracker as single source of truth

### 4. WebSocket Events Before Actions

- Event listeners registered during SDK init
- Events update dealTracker in real-time
- Actions read updated state

### 5. Stateless Actions, Stateful Services

- Each action is stateless
- Services hold all state (SDK, deal tracker)
- Actions update services, read from services

## 🚀 How It Works

### On Startup

```bash
npm run buyer
```

1. Parse CLI args (`--role buyer`, `--private`)
2. Load `.env` (keys, URLs, constraints)
3. Initialize MeridianSDK (register + connect)
4. Set up event handlers
5. Create ElizaOS runtime with character
6. Register airotcPlugin (8 actions + provider)
7. Initialize runtime
8. Enter main loop

### In the Main Loop (every 2 seconds)

1. Check deal phase
2. If complete, exit
3. If idle/negotiating/etc, ElizaOS decides next action
4. ElizaOS calls provider → gets context
5. LLM reads context + character → selects action
6. Action runs → updates dealTracker
7. Loop continues

### On Deal Completion

```
Phase: completed
 ↓
Main loop detects it
 ↓
Exit gracefully
 ↓
Process terminates
```

## 💾 What Gets Stored Where

| Data | Storage | Persistence |
| --- | --- | --- |
| Deal phase, ticket, escrow | dealTracker (RAM) | Optional file via SDK |
| Connection + auth | MeridianClient | WebSocket (reconnect on drop) |
| Actions + provider logic | ElizaOS plugin | Code (in .ts files) |
| Agent personality | character.ts | Code (in .ts file) |
| Runtime configuration | .env | File |

## 🔌 Integration Points

### With MeridianClient

- **APIs used**: `createOffer()`, `acceptOffer()`, `getOffers()`, `sendMessage()`, `sendDeposit()`, `confirmDeposit()`, `confirmReceipt()`, `openDispute()`, `subscribeToTicket()`
- **Events listened**: `phase_changed`, `message`, `escrow_address`, `deal_complete`, `error`

### With ElizaOS

- **Used**: `AgentRuntime`, `Action`, `Provider`, `Plugin`, `Memory`, `State`, `elizaLogger`
- **Model provider**: Groq (configured in `.env`)

### With Solana

- **RPC**: devnet (configurable)
- **Actions**: Airdrop test SOL, query balance, confirm txs on explorer

## ✅ Verification Checklist

- [x] Real ElizaOS framework (not wrapper)
- [x] 8 autonomous actions implemented
- [x] Provider injects context into LLM
- [x] Deal tracker persists state
- [x] SDK is singleton
- [x] Event listeners wired before actions
- [x] Support for buyer + seller roles
- [x] Support for ER + PER modes
- [x] Full deal lifecycle works
- [x] No gpt-4o-mini (uses Groq)
- [x] No demo_force_completed
- [x] No guessed ElizaOS APIs
- [x] Handles timeouts + retries
- [x] Graceful shutdown

## 🧪 Testing

See [TESTING.md](./TESTING.md) for end-to-end test procedures.

### Quick Test

```bash
# Terminal 1: Backend
cd middleman-agent && npx ts-node src/index.ts

# Terminal 2: Seller
cd agents/elizaos-agent && npm run seller

# Terminal 3: Buyer
cd agents/elizaos-agent && npm run buyer
```

Expected: Both complete a deal in < 90 seconds (ER mode).

## 📖 Files Reference

| File | Purpose |
| --- | --- |
| `index.ts` | Entry point, boots ElizaOS, main loop |
| `character.ts` | Agent personality, system prompt, examples |
| `actions/*.ts` | 8 autonomous operations |
| `providers/airotcProvider.ts` | Injects deal status into LLM calls |
| `plugins/airotcPlugin.ts` | Registers actions + providers |
| `services/meridianSDK.ts` | Singleton wrapper around MeridianClient |
| `services/dealTracker.ts` | Persists deal state across invocations |
| `package.json` | Dependencies (ElizaOS, Solana, etc.) |
| `.env` | Configuration (keys, URLs, constraints) |
| `README.md` | User guide (how to run) |
| `TESTING.md` | Test procedures |

## 🎓 Key Learnings

1. **ElizaOS is plugin-based**: Actions + providers are composable
2. **Context is king**: Providers inject state into every LLM call
3. **Events beat polling**: WebSocket events trigger state updates
4. **Singleton services**: One connection per process, reused by all actions
5. **Deal state matters**: Tracker is single source of truth
6. **No side effects**: Actions are pure functions (read state, do work, emit message)

## 🔮 Future Enhancements

- [ ] Database for deal history
- [ ] Auto-recovery on disconnect
- [ ] Sophisticated pricing logic (market-based)
- [ ] Multi-asset support (not just SOL)
- [ ] On-chain order book integration
- [ ] Dispute resolution metrics
- [ ] Performance tuning (faster deal cycles)
- [ ] Logging to file (not just stdout)
- [ ] Metrics export (Prometheus/Grafana)

---

**Status**: ✅ Ready for production testing

**Build Date**: 2026-05-01

**Framework**: ElizaOS + MeridianClient + Solana

**Author**: Autonomous Agent Development Team
> Supporting Reference
>
> This implementation summary is preserved for detailed background.
> The primary canonical entrypoint for the ElizaOS agent package is:
> - [README.md](/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/README.md)
