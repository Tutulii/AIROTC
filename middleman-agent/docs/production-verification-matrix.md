# Production Verification Matrix

This document is the current source of truth for validating the ER/PER + downstream pipeline stack in `middleman-agent`.

## PER Strict Opaque Mode

The target production contract for `PER` is:

- middleman may know:
  - buyer wallet
  - seller wallet
  - ticket id
  - session PDA
  - terms hash
  - ciphertext handles
  - funding commitment hashes
  - funding state
  - approval state
  - winner / settlement-valid result
- middleman may not know:
  - plaintext price
  - plaintext buyer collateral
  - plaintext seller collateral

Operational rules when `PER_STRICT_OPAQUE_MODE=true`:
- the backend must never promote PER from plaintext chat terms
- matched PER tickets must not seed plaintext terms into the middleman negotiation brain
- the API-server marketplace bridge must not forward plaintext `price` or `collateral` into `/v1/deals/create-matched`
- API-side matched-ticket and recent-deal reads must mark PER terms as redacted instead of exposing stale server-side numbers as authoritative
- release and funding requests sent from the server remain redacted
- buyer and seller SDKs hydrate those requests from their local private term cache
- the legacy standalone Umbra 5-phase settlement lifecycle is test-only and must never be used as a production fallback

## Final truth table

When `PER_STRICT_OPAQUE_MODE=true`, the production trust split is:

| Actor | May know | Must not know |
| --- | --- | --- |
| Buyer agent / SDK | Full local negotiated terms, its own funding amounts, release/dispute intent, settlement target | Counterparty private cache internals |
| Seller agent / SDK | Full local negotiated terms, its own funding amounts, dispute intent, settlement target | Counterparty private cache internals |
| Middleman | Buyer wallet, seller wallet, ticket id, session PDA, deal PDA, terms hash, ciphertext handles, funding commitment hashes, funding status, settlement-plan approval state, buyer release confirmation state, dispute state, winner / settlement-valid result | Plaintext price, plaintext buyer collateral, plaintext seller collateral, raw PER bargaining transcript |
| On-chain confidential escrow | Recorded deposits, commitment bindings, approval/dispute state, settlement target, release-executed state | Chat transcript, off-chain delivery evidence beyond signed approvals/dispute actions |

Non-negotiable production rules:
- the middleman is an orchestrator, not the payout calculator
- payout math must come from the confidential escrow program and recorded deposits
- PER funding and release requests sent by the server remain redacted
- agents may only hydrate PER funding/release UX from their local private term cache
- if local private terms are missing, strict PER must fail closed

## Residual non-cryptographic reality

This stack now hides negotiated price/collateral from the middleman runtime in strict PER mode, but one real-world boundary still exists:

- off-chain delivery is authorized by:
  - signed buyer release confirmation
  - seller dispute window
  - optional manual/operator resolution if a dispute opens

It is not possible for this repo alone to produce cryptographic proof that a physical or off-chain good was received. The production claim is therefore:

- cryptographically private settlement math and funding flow
- signed human approval/dispute gate for off-chain delivery

## Marketplace-backed PER flow

The supported production marketplace contract is:

1. agent creates a `PER` offer on the API server
2. another agent lists and accepts that offer
3. the matched ticket is forwarded to the middleman with `rollupMode=PER`
4. the offer board and ticket APIs stay redacted after matching
5. private numeric agreement happens through SDK rollup methods, not chat parsing
6. the confidential pipeline settles from proof, commitments, and signed approvals

Important:
- public offer discovery is still allowed
- matched `PER` tickets must not expose authoritative plaintext price/collateral from the API server
- the frontend should describe `PER` as SDK-driven private negotiation after accept, not as plain chat settlement

## Critical pipeline suite

Use this to verify the downstream orchestration, recovery, stealth lifecycle, and confidential-settlement state handling:

```bash
npm run test:pipeline:critical
```

Coverage:
- `dealPipeline` route convergence
- rollup-backed `ER/PER -> confidential + stealth` downstream contract
- seller balance-readiness stage wiring
- settlement-address resolution
- stealth settlement preparation
- full stealth settlement lifecycle orchestration
- pipeline recovery, including `settled_pending_session_close`
- listener-level app flow:
  - `rollup_consensus_reached -> agreement_detected`
  - `agreement_detected -> dealPipeline.start(...)`

## Component E2Es

Use this to validate the shared downstream services against live devnet-compatible infrastructure:

```bash
npm run test:component:e2e
```

Coverage:
- seller balance-readiness policy guard
- `Encrypt` live devnet E2E
- `Umbra` live devnet E2E

Notes:
- seller balance-readiness checks are environment-sensitive:
  - `mainnet-beta`: recommended `ZERION_VERIFICATION_MODE=strict`
  - `devnet`: keep `ZERION_VERIFICATION_MODE=hybrid` because the full MagicBlock/Encrypt/IKA/Umbra stack currently runs there while Zerion wallet data is mainnet-oriented
- `Encrypt` and `Umbra` tests now fall back to the configured `PRIVATE_KEY` if `PAYER_SECRET_KEY` is not provided.
- These tests still use live services, so intermittent provider/network instability can fail a run without implying a code regression.

## Rollup live validation

Use this to validate the actual `MagicBlock ER` and `MagicBlock PER` flows:

```bash
npm run test:rollup:live
```

Coverage:
- `ER` public negotiation lifecycle
- `PER` private handoff, TEE commit, L1 close, scrubbed-state verification

## Full stack gate

Run the full stack gate before high-confidence deploys:

```bash
npm run test:prod:stack
```

This runs:
1. `typecheck`
2. critical downstream pipeline suite
3. shared component E2Es
4. live ER/PER rollup E2Es

## Harness-backed live confidential pipeline proof

Use this when you want the strongest live downstream proof in this repo without claiming a literal full frontend/api deployment proof:

```bash
npm run test:diagram:live
```

Coverage:
- public route:
  - `MeridianClient SDK -> ER -> balance-readiness -> stealth addressing -> Encrypt -> confidential Anchor -> settlement-plan approvals -> buyer release confirmation -> seller dispute window -> IKA -> stealth settlement`
- private route:
  - `MeridianClient SDK -> PER -> balance-readiness -> stealth addressing -> Encrypt -> confidential Anchor -> settlement-plan approvals -> buyer release confirmation -> seller dispute window -> IKA -> stealth settlement`

Boundary:
- this is a harness-backed live proof with real WS clients, live vendor calls, and on-chain assertions
- it is not the literal full marketplace/app runtime proof

For the strongest harness-backed downstream proof pack, run:

```bash
npm run test:prod:harnessed-full
```

This runs the existing production stack plus the harness-backed live diagram E2E.

If you want the real deployment-readiness gate for this repo, run:

```bash
npm run test:phase8:gate
```

That is the authoritative final gate. `test:prod:harnessed-full` is intentionally narrower.

## Phase 7 proof gates

Use these when you want dedicated proof artifacts for strict opaque `PER` and the
marketplace-backed `PER` path instead of only the shared diagram harness.

Strict opaque `PER` contract:

```bash
npm run test:per:strict:e2e
```

This runs:
- `tests/no_plaintext_per_logs.test.ts`
- `tests/no_plaintext_per_persistence.test.ts`
- `tests/private_execution_terms.test.ts`
- `tests/per_strict_legacy_paths.test.ts`

If you want the live private proofs too:

```bash
npm run test:per:strict:live
```

That adds:
- `test/per_redaction_e2e_test.ts`
- `test/full_diagram_live_e2e.ts buyer_only private_only`

Marketplace-backed `PER` proof pack:

```bash
npm run test:marketplace:per:proof
```

This runs:
1. API package typecheck gate
2. frontend marketplace compile gate
3. API marketplace `PER` bridge/redaction/offer-flow + observatory stats proofs
4. middleman marketplace `PER` contract + observatory bridge proof

Boundary:
- this is an honest proof pack for marketplace-side redaction, observatory reconciliation, and contract safety
- the harness-backed live downstream settlement proof still lives in `npm run test:diagram:live`

Combined Phase 7 proof pack:

```bash
npm run test:phase7:proof
```

## Phase 8 final acceptance gate

Run this before claiming the stack is deployment-ready on the current devnet + pre-alpha vendor surface:

```bash
npm run test:phase8:gate
```

This runs:
1. `api-server` typecheck
2. `middleman-agent` typecheck
3. critical downstream pipeline suite
4. strict opaque PER proof pack
5. marketplace-backed PER proof pack
6. live PER redaction + buyer-only gate proof
7. full diagram soak gate

Interpretation:
- a passing run proves:
  - no known plaintext PER promotion path is active
  - PER marketplace accept flow remains redacted
  - buyer-only release still blocks correctly
  - public + private happy-path settlement still survives the full diagram soak
- a failing run must be classified before being treated as a product regression:
  - `magicblock_tee`
  - `magicblock_auth`
  - `encrypt`
  - `ika`
  - `solana_rpc`
  - `umbra`
  - `internal_pipeline`
  - `unknown`

## Full diagram soak gate

Use this when you want repeatability evidence, not just a single green run:

```bash
npm run test:diagram:soak
```

Default scenarios:
- `PER buyer-only approval gate`
- `Full ER+PER happy path`

Default iteration count:
- `DIAGRAM_SOAK_RUNS=5`

Useful knobs:
- `DIAGRAM_SOAK_RUNS`
  - number of iterations
- `DIAGRAM_SOAK_SCENARIOS`
  - comma-separated scenario ids:
  - `private_blocked`
  - `public_blocked`
  - `full_happy_path`
- `DIAGRAM_SOAK_TRANSIENT_RETRIES`
  - retries for transient upstream failures

Example:

```bash
DIAGRAM_SOAK_RUNS=5 DIAGRAM_SOAK_SCENARIOS=private_blocked,full_happy_path npm run test:diagram:soak
```

Local artifacts:
- per-run logs and a JSON summary are written to the local diagram-soak output directory
- submission-safe summaries are copied to:
  - `docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json`
  - `docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json`
- each scenario result now includes proof tags such as:
  - `phase7`
  - `strict_per`
  - `approval_gate`
  - `happy_path`

Failure classification buckets:
- `magicblock_tee`
- `magicblock_auth`
- `encrypt`
- `ika`
- `solana_rpc`
- `umbra`
- `approval_gate`
- `internal_pipeline`
- `unknown`

For a stronger stability gate, run:

```bash
npm run test:prod:stability
```

This runs:
1. `typecheck`
2. `test:pipeline:critical`
3. `test:diagram:soak`

For a structured campaign artifact with dependency-classified live stability results, run:

```bash
npm run test:stability:campaign
```

Local artifacts:
- per-suite logs and a JSON summary are written to the local stability-campaign output directory
- raw stability-campaign logs are excluded from the public submission bundle unless a sanitized summary is copied into `docs/proof-evidence/`

## Definition of done

Phase 8 is complete only when all of the following are true:

- a PER offer can be created from the marketplace/API surface
- PER offers remain publicly discoverable before match
- accepting a PER offer preserves `rollupMode=PER`
- the API-server marketplace bridge does not forward plaintext price/collateral into the middleman when strict PER is enabled
- the matched ticket and recent-deal read surfaces stay redacted after PER matching
- private numeric agreement happens through SDK rollup methods, not chat parsing
- the middleman promotes PER only from proof, hashes, ciphertext handles, and commitments
- buyer and seller fund from local private terms only
- server-side funding and release requests stay redacted
- missing local private terms fail closed
- buyer-only release remains blocked until seller settlement-plan approval exists
- buyer release confirmation plus seller dispute window drive final release
- the escrow program computes payouts from recorded deposits and settlement state, not from middleman-supplied amounts
- the legacy standalone Umbra lifecycle remains disabled in production mode
- strict opaque PER proof pack is green
- marketplace-backed PER proof pack is green
- live PER buyer-only gate proof is green
- full diagram soak gate is green

## Deployment claim boundary

If all of the gates above pass, this repo can honestly claim:

- strict opaque PER is production-shaped inside this codebase
- the middleman no longer needs plaintext price/collateral to continue PER deals
- marketplace accept -> private negotiation -> confidential settlement is covered by proof artifacts

It still cannot honestly claim that external vendor dependencies are boring mainnet-grade infrastructure. Current remaining external-risk sources are:

- MagicBlock TEE / auth / permission propagation
- Encrypt availability
- IKA pre-alpha reliability
- Solana devnet/RPC instability

## Current expectations

Successful current-state validation should show:

- rollup-backed tickets:
  - `ER` and `PER` both converge into the same confidential + stealth downstream route
- ER final L1 state:
  - `agreedPrice > 0`
  - `agreedAsset != ""`
  - `status = consensusReached`
- PER final L1 state:
  - `agreedPrice = 0`
  - `agreedAsset = ""`
  - `buyerCollateral = 0`
  - `sellerCollateral = 0`
  - `status = confidentialHandoff`
- Encrypt:
  - live ciphertext creation
  - decryption request succeeds
  - verified decryption completes
- Umbra:
  - client init
  - registration check
  - account query
  - encrypted balance query
  - incoming UTXO scan succeeds
- Full diagram live E2E:
  - public route settles via stealth address
  - private route settles via stealth address
  - private final L1 session remains scrubbed with `status = confidentialHandoff`
  - buyer-only settlement-plan approval leaves the deal blocked at `awaiting_settlement_plan_approvals`
  - funds remain unmoved until the missing seller settlement-plan approval is added, then buyer release confirmation is collected and the seller dispute window elapses
- seller balance-readiness policy:
  - `mainnet-beta` + `strict` means a trade fails closed unless Zerion confirms the seller wallet position
  - `devnet` + `hybrid` means the full stack can still be proven live while balance-readiness falls back to on-chain balance checks

## Recovery contract

The current recovery contract is:

- `pending_confidential_session_close`
  - confidential execution completed
  - PER final close still needs retry
- `settled_pending_session_close`
  - settlement already completed
  - only PER final close still needs retry

Startup recovery should reconcile both states automatically.

## Release-approval contract

The current confidential release model is:

1. buyer and seller both approve the settlement plan
2. buyer confirms final release
3. seller gets a dispute window
4. if no dispute is opened before the deadline, `IKA` signs and `reveal_and_release` can execute

This replaces the older stricter model where both parties had to provide a second final-release approval.

## IKA gas-deposit policy

The current default is `IKA_GAS_DEPOSIT_MODE=detect_only`.

Reason:
- the official pre-alpha docs document `GasDeposit`, but do not publish a stable
  Solana client account contract for `CreateDeposit`
- the live dWallet DKG/sign flow currently succeeds without proactively creating
  the deposit
- production-safe initialization should avoid emitting a false-negative startup
  failure for an upstream pre-alpha instruction contract that is not yet stable

Modes:
- `detect_only`
  - read an existing deposit if present
  - do not proactively create one
- `create`
  - best-effort `CreateDeposit`
  - logs a warning if upstream pre-alpha creation still fails
- `require_create`
  - strict mode
  - initialization fails if `CreateDeposit` cannot be completed

## Seller balance-readiness policy

The current policy knob is `ZERION_VERIFICATION_MODE`.

Modes:
- `hybrid`
  - prefer Zerion when the runtime network supports it
  - fall back to Solana RPC wallet-balance observation when Zerion is unavailable or the runtime is not supported
- `strict`
  - require Zerion confirmation
  - fail closed if the API key is missing, the runtime is unsupported, the API request fails, or Zerion reports insufficient seller wallet balance
- `rpc_only`
  - bypass Zerion entirely
  - useful for local/dev fallback only, not the recommended production mode

Important boundary:
- the current implementation provides `balance_readiness`, not custody or asset locking
- payout safety still comes from funded confidential escrow deposits and on-chain release enforcement, not from Zerion itself
