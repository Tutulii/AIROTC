# SDK E2E Test Logs — Successful Run
**Date:** April 13, 2026 ~11:50 UTC  
**Network:** Solana Devnet  
**Deal Ticket:** `c0d4944c-69c6-497a-8014-af6eaed1da18`  
**Escrow PDA:** `D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ`  
**Result:** ✅ DEAL COMPLETE (both agents exit code 0)

---

## 1. Buyer SDK Logs (`example-buyer.ts`)

```
[BUYER-SDK] Wallet: A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V
[SDK] Registered: A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V (new=false)
[SDK] WebSocket connected to ws://localhost:3001
[SDK] Authenticated. Agent ID: d184da7f-a695-4596-a890-a1c90f85141f
[SDK] Offer posted: 15834cf5-5f5a-4a6e-a247-552875753815 (1 SOL @ 0.1)
[BUYER-SDK] Ticket: 15834cf5-5f5a-4a6e-a247-552875753815
[SDK] Ticket ID switched: 15834cf5-5f5a-4a6e-a247-552875753815 → c0d4944c-69c6-497a-8014-af6eaed1da18
[BUYER-SDK] [negotiation] 🤝 Deal matched. Buyer: A4bCoAbe... | Seller: AgS7QL5E...
  Asset: SOL | Amount: 1 | Price: 0.1
  Both parties — please confirm terms.
[BUYER-SDK] Agreement sent to middleman (ticket: c0d4944c-69c6-497a-8014-af6eaed1da18)
[BUYER-SDK] [negotiation] Buyer has confirmed the deal, but seller has not yet confirmed and agreement_score is only 50/100.
[BUYER-SDK] Phase → escrow_created
[BUYER-SDK] [escrow_created] 📋 Deal phase updated: **negotiation** → **escrow_created** (triggered by 8f0edf87-6d4f-4750-b861-3ffc120db04d)
[BUYER-SDK] [escrow_created] [Fallback] Action registered. Data:
  ACTION: Deal created on-chain.
  TERMS: Price=0.1 SOL, Buyer Collateral=0.02 SOL, Seller Collateral=0.02 SOL.
[BUYER-SDK] Phase → awaiting_deposits
[BUYER-SDK] [awaiting_deposits] 📋 Deal phase updated: **escrow_created** → **awaiting_deposits** (triggered by system)
[BUYER-SDK] [created_awaiting_deposits] ⚡ Deal execution update: status is now **created_awaiting_deposits**. Escrow address: **D9DHHN9bkV9SL8cLvXmH84viX2YSpVSP**
[BUYER-SDK] Escrow detected: D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ
[BUYER-SDK] [awaiting_deposits] [Fallback] Action registered. Data:
  ACTION: Awaiting Deposits.
  ESCROW ADDRESS: `D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ`
[SDK] Deposit sent: 0.02 SOL → D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ (tx: 2eAzX3WwmoX5ykg4Kj1VSD3Wxyybbqkjf7B5ERK6LMWLS3VDXHzUapPVjCYFPzNpM9pBPQznGjiq1c6vSD77iTQc)
[BUYER-SDK] Collateral sent: 2eAzX3WwmoX5ykg4Kj1VSD3Wxyybbqkjf7B5ERK6LMWLS3VDXHzUapPVjCYFPzNpM9pBPQznGjiq1c6vSD77iTQc
[SDK] Deposit confirmed (buyer)
[BUYER-SDK] Phase → delivery
[BUYER-SDK] [delivery] 📋 Deal phase updated: **awaiting_deposits** → **delivery** (triggered by system)
[BUYER-SDK] [negotiation] Delivery: ACCESS_TOKEN_12345
[SDK] Deposit sent: 0.1 SOL → D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ (tx: 23E7aNh6z8FzqPuJrAHWQYBh7hDND1kyNNGfKKYGvMoZqTbAh6QgRXKfT2CYZPxRKkyVp74KVmSvzmaQayz3sCR4)
[BUYER-SDK] Payment sent: 23E7aNh6z8FzqPuJrAHWQYBh7hDND1kyNNGfKKYGvMoZqTbAh6QgRXKfT2CYZPxRKkyVp74KVmSvzmaQayz3sCR4
[SDK] Receipt confirmed — requesting fund release
[BUYER-SDK] Phase → completed
[BUYER-SDK] ✅ DEAL COMPLETE: c0d4944c-69c6-497a-8014-af6eaed1da18
[BUYER-SDK] [completed] 📋 Deal phase updated: **delivery** → **completed** (triggered by d184da7f-a695-4596-a890-a1c90f85141f)
[BUYER-SDK] [completed] [Fallback] Action registered. Data:
  ACTION: Deal Complete & Funds Released.
  PAYOUTS: Seller receives 0.1 (payment) + 0.02 (refund). Buyer receives 0.02 (refund).

Exit code: 0
```

---

## 2. Seller SDK Logs (`example-seller.ts`)

```
[SELLER-SDK] Wallet: AgS7QL5Eun3KS78TU35jP54DaVxQCM9UhqitqRKmczNS
[SDK] Registered: AgS7QL5Eun3KS78TU35jP54DaVxQCM9UhqitqRKmczNS (new=false)
[SDK] WebSocket connected to ws://localhost:3001
[SDK] Authenticated. Agent ID: 8f0edf87-6d4f-4750-b861-3ffc120db04d
[SELLER-SDK] Scanning for buy offers...
[SELLER-SDK] Found offer: 15834cf5-5f5a-4a6e-a247-552875753815 (1 SOL @ 0.1)
[SDK] Accepted offer. Ticket: c0d4944c-69c6-497a-8014-af6eaed1da18
[SELLER-SDK] Joined ticket: c0d4944c-69c6-497a-8014-af6eaed1da18
[SELLER-SDK] [negotiation] 🤝 Deal matched. Buyer: A4bCoAbe... | Seller: AgS7QL5E...
  Asset: SOL | Amount: 1 | Price: 0.1
  Both parties — please confirm terms.
[SELLER-SDK] [negotiation] @middleman I confirm the deal. Price: 0.1 SOL, collateral: 0.02 SOL each.
[SELLER-SDK] [negotiation] Buyer has confirmed the deal, but seller has not yet confirmed and agreement_score is only 50/100.
[SELLER-SDK] [escrow_created] 📋 Deal phase updated: **negotiation** → **escrow_created** (triggered by 8f0edf87-6d4f-4750-b861-3ffc120db04d)
[SELLER-SDK] [escrow_created] [Fallback] Action registered. Data:
  ACTION: Deal created on-chain.
  TERMS: Price=0.1 SOL, Buyer Collateral=0.02 SOL, Seller Collateral=0.02 SOL.
[SELLER-SDK] [awaiting_deposits] 📋 Deal phase updated: **escrow_created** → **awaiting_deposits** (triggered by system)
[SELLER-SDK] [created_awaiting_deposits] ⚡ Deal execution update: status is now **created_awaiting_deposits**. Escrow address: **D9DHHN9bkV9SL8cLvXmH84viX2YSpVSP**
[SELLER-SDK] Escrow detected: D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ
[SELLER-SDK] [awaiting_deposits] [Fallback] Action registered. Data:
  ACTION: Awaiting Deposits.
  ESCROW ADDRESS: `D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ`
[SDK] Deposit sent: 0.02 SOL → D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ (tx: 5AYagdU13uriFKbkzo6auTKGdpNgcFhapf4MSKm3UjkiGxYBwC7BbfjTvnkptjeouwwJb9sqBxWVueHjopWaKZDA)
[SELLER-SDK] Collateral sent: 5AYagdU13uriFKbkzo6auTKGdpNgcFhapf4MSKm3UjkiGxYBwC7BbfjTvnkptjeouwwJb9sqBxWVueHjopWaKZDA
[SDK] Deposit confirmed (seller)
[SELLER-SDK] [delivery] 📋 Deal phase updated: **awaiting_deposits** → **delivery** (triggered by system)
[SELLER-SDK] Credentials delivered
[SELLER-SDK] [negotiation] @middleman I received the credentials. You can release the funds now.
[SELLER-SDK] ✅ DEAL COMPLETE: c0d4944c-69c6-497a-8014-af6eaed1da18
[SELLER-SDK] [completed] 📋 Deal phase updated: **delivery** → **completed** (triggered by d184da7f-a695-4596-a890-a1c90f85141f)
[SELLER-SDK] [completed] [Fallback] Action registered. Data:
  ACTION: Deal Complete & Funds Released.
  PAYOUTS: Seller receives 0.1 (payment) + 0.02 (refund). Buyer receives 0.02 (refund).

Exit code: 0
```

---

## 3. On-Chain Transactions (Solana Devnet)

| Step | SOL Amount | Tx Signature | Explorer |
|---|---|---|---|
| Buyer Collateral | 0.02 | `2eAzX3Wwmo...` | [View](https://explorer.solana.com/tx/2eAzX3WwmoX5ykg4Kj1VSD3Wxyybbqkjf7B5ERK6LMWLS3VDXHzUapPVjCYFPzNpM9pBPQznGjiq1c6vSD77iTQc?cluster=devnet) |
| Seller Collateral | 0.02 | `5AYagdU13u...` | [View](https://explorer.solana.com/tx/5AYagdU13uriFKbkzo6auTKGdpNgcFhapf4MSKm3UjkiGxYBwC7BbfjTvnkptjeouwwJb9sqBxWVueHjopWaKZDA?cluster=devnet) |
| Buyer Payment | 0.10 | `23E7aNh6z8...` | [View](https://explorer.solana.com/tx/23E7aNh6z8FzqPuJrAHWQYBh7hDND1kyNNGfKKYGvMoZqTbAh6QgRXKfT2CYZPxRKkyVp74KVmSvzmaQayz3sCR4?cluster=devnet) |
| On-Chain Payment Confirm | — | `RTxRdDfyRt...` | [View](https://explorer.solana.com/tx/RTxRdDfyRthiShsCRAzWak1RHuXX8C4TqB888UPnNS3r9FhAohCW1bsTqNqauGDKn6E44dMiJJ9dZdauy6Bw4LV?cluster=devnet) |

---

## 4. Middleman Brain Key Events

```json
// Seller agreement processed → CREATE_ESCROW triggered
{"event":"react_agent_decision","ticket_id":"c0d4944c-...","action":"CREATE_ESCROW","thought":"Both parties confirmed terms. Agreement score 100. Phase is negotiation. Creating escrow."}

// Escrow created on-chain
{"event":"deal_created_on_chain","ticket_id":"c0d4944c-...","escrow_pda":"D9DHHN9bkV9SL8cLvXmH84viX2YSpVSPVeRMVoGJrNXJ"}

// Deposit watcher detects buyer collateral
{"event":"deposit_identified","ticket_id":"c0d4944c-...","deposit_type":"buyer_collateral","amount":0.02}

// Deposit watcher detects seller collateral
{"event":"deposit_identified","ticket_id":"c0d4944c-...","deposit_type":"seller_collateral","amount":0.02}

// Phase → delivery (all collateral confirmed)
{"event":"deal_phase_transition","ticket_id":"c0d4944c-...","from":"awaiting_deposits","to":"delivery"}

// Deposit watcher detects buyer payment
{"event":"deposit_identified","ticket_id":"c0d4944c-...","deposit_type":"buyer_payment","amount":0.1}

// Payment confirmed on-chain
{"event":"deposit_confirmed_onchain","ticket_id":"c0d4944c-...","deposit_type":"buyer_payment","tx":"RTxRdDfyRt..."}

// Deal fully funded
{"event":"deal_fully_funded","ticket_id":"c0d4944c-...","payment_locked":true}

// Buyer receipt → RELEASE_FUNDS (Soul Guard PASSED)
{"event":"react_agent_decision","ticket_id":"c0d4944c-...","action":"RELEASE_FUNDS","thought":"Buyer confirmed receipt in delivery phase. Evidence verified. Releasing funds."}

// Deal → completed 
{"event":"deal_phase_transition","ticket_id":"c0d4944c-...","from":"delivery","to":"completed"}
```

---

## 5. Deal Lifecycle Summary

```
negotiation ──────────────────→ escrow_created ──→ awaiting_deposits ──→ delivery ──→ completed
     │                              │                    │                  │            │
Buyer confirms terms    Escrow PDA created     Both collaterals     Seller delivers  Buyer confirms
Seller confirms terms   on Solana Devnet       deposited on-chain   ACCESS_TOKEN     receipt → funds
 @middleman mention                            Buyer sends 0.10     credentials      released
                                               SOL payment                           on-chain
```

---

## 6. Bugs Fixed to Reach This Point

| # | File | Bug | Fix |
|---|---|---|---|
| 1 | `negotiationStore.ts` | FK violation crashed middleman when WS messages arrived before ticket persisted | Retry-after-delay: wait 1.5s then retry once |
| 2 | `MeridianClient.ts` | Buyer sent messages to offer ID, but middleman used matched ticket ID | Auto-switch: detect real ticket_id from incoming messages |
| 3 | `MeridianClient.ts` | `confirmReceipt` used type `confirm_delivery` which WS gateway didn't route to brain | Changed to type `message` for proper routing |
| 4 | `MeridianClient.ts` | Only listened for `middleman_message` events | Added `middleman_response` event handling |
| 5 | `example-buyer.ts` | Used stale offer ID for all post-match operations | Uses `getCurrentTicketId()` dynamically |
| 6 | `example-buyer.ts` | Agreement missing `@middleman` mention | Added explicit `@middleman` + deal terms |
| 7 | `example-seller.ts` | Sent 0.05 SOL collateral instead of 0.02 | Fixed to match deal terms |
| 8 | `middlemanBrain.ts` | `evidenceVerified` didn't check live phase from dealPhaseManager | Added livePhase check + `currentPhase === 'delivery'` |
