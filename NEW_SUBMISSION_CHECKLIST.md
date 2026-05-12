# AIR OTC Submission Checklist

Last updated: 2026-05-10

This is the canonical judge-facing checklist for AIR OTC's devnet submission package. If you only read one file before assembling the final packet, read this first.

## 1. Canonical reading order

Use these files in this order:

1. [SUBMISSION_README.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_README.md)
2. [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
3. [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
4. [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
5. [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
6. [docs/HOW_TO_VERIFY.md](/Users/tutul/Downloads/AIR OTC/docs/HOW_TO_VERIFY.md)
7. [docs/JUDGE_DEMO_SCRIPT.md](/Users/tutul/Downloads/AIR OTC/docs/JUDGE_DEMO_SCRIPT.md)
8. [sdk/README.md](/Users/tutul/Downloads/AIR OTC/sdk/README.md)
9. [runtime/air-otc/README.md](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/README.md)
10. [agents/elizaos-agent/README.md](/Users/tutul/Downloads/AIR OTC/agents/elizaos-agent/README.md)
11. [frontend/README.md](/Users/tutul/Downloads/AIR OTC/frontend/README.md)

## 2. Current product story

AIR OTC should currently be presented as:

- an agent-to-agent OTC settlement system for Solana
- a devnet-proven product with four public surfaces:
  - SDKs for technical builders
  - a no-code runtime for non-technical operators
  - a read-only observatory frontend for humans
  - an MCP agent/operator interface
- a system whose strongest live path is strict PER with online Zerion check, shielded-credit funding, encrypted delivery, buyer release confirmation, full Umbra lifecycle evidence, and post-settlement Torque sidecar delivery
- a trust-minimized and privacy-hardened system, not a fully trustless or mainnet-ready system

## 3. Current verified acceptance snapshot

The current repo-backed acceptance snapshot is:

- TypeScript SDK build and tests pass
- Python SDK compile and PER golden-vector checks pass
- no-code runtime typecheck and build pass
- escrow confidential program `cargo check`, `cargo test`, and `anchor build` pass
- shielded-credit confidential escrow program is deployed on devnet at `BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj`
- MCP typecheck, build, test, stdio/HTTP surfaces, and audit pass
- frontend build passes
- API server typecheck and production-readiness vitest set pass
- middleman full test run reports `258` passed tests and `1` intentionally skipped Dune SIM E2E gate
- latest TypeScript SDK PER shielded-credit proof succeeded on ticket `876bef08-88fc-4c19-880c-974a06e43916`
- latest ElizaOS external-agent PER shielded-credit proof succeeded on ticket `5826ad0a-04df-4d29-b5f8-d30563bf0752`
- latest ElizaOS full-pipeline devnet proof succeeded on ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c`
- latest fresh diagram-soak smoke rerun passed `2/2` runs on 2026-05-10, with `1/1` PER buyer-only approval gate and `1/1` full ER+PER happy path
- historical full default diagram soak passed `10/10` runs on 2026-05-06; the 2026-05-10 default long soak attempt reached `4/5` live passes before external devnet dependencies interrupted completion
- latest no-code runtime PER pair proof succeeded on ticket `e2023f32-3b36-45be-b27b-d7ced1352317`

## 4. Proof artifacts worth surfacing

Use these when building a judge packet or walkthrough:

- [SUBMISSION_README.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_README.md) for the short judge entrypoint
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md) for verified commands and proof ticket IDs
- [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md) for claim-to-code mapping
- [docs/HOW_TO_VERIFY.md](/Users/tutul/Downloads/AIR OTC/docs/HOW_TO_VERIFY.md) for the judge verification command path
- [docs/JUDGE_DEMO_SCRIPT.md](/Users/tutul/Downloads/AIR OTC/docs/JUDGE_DEMO_SCRIPT.md) for the 3-5 minute demo script
- [SUBMISSION_FINAL_REPORT.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_FINAL_REPORT.md) for final Day 3 package status
- latest full-pipeline devnet proof:
  - ticket `13e6ae1d-68d0-46f0-a50a-6329965b598c`
  - offer `5024c326-3b75-4d7f-9aba-75c4aad05adb`
  - escrow PDA `5PrqGPyMspsPehK2h1PVpo3Fd4R2Pdo4TyAdqhmi7h9K`
  - Zerion online snapshot hash `4b7726760eb4356345de5e51c3066ee6538b9fc0882c2281078bbcc8d3774969`
  - release tx `4UZWGTGWXb6uiyjfS3sk9pJtxNn1cCdxAnDhjAxhRonxwQrd9aCgrLUTEY9FEmPkabS1b7eQQ5K6U9TJbe3xAZrJ`
  - approval tx `2XpFSUacn2odVAZ8xy5pncei8bARX8PoFBsqw9zH2JzD5QkafzP7iBYTSWmfsgFGFwZSN8qCJiVgkjZwhaZwB6Ye`
  - audit contains `confidential_shielded_credit_settled`, `deal_pipeline_settled_confirmed`, and `deal_pipeline_umbra_lifecycle_completed_confirmed`
- latest TypeScript SDK PER shielded-credit proof:
  - ticket `876bef08-88fc-4c19-880c-974a06e43916`
- latest ElizaOS PER shielded-credit proof:
  - ticket `5826ad0a-04df-4d29-b5f8-d30563bf0752`
  - offer `5f343603-271b-40c9-9dda-e3bd32189ec3`
- latest no-code runtime proof:
  - ticket `e2023f32-3b36-45be-b27b-d7ced1352317`
  - offer `9be62187-a6b8-4e02-bb98-192f4582b741`
- latest fresh soak summary:
  - [/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-10-smoke-summary.json)
- historical full soak summary:
  - [/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json](/Users/tutul/Downloads/AIR OTC/docs/proof-evidence/diagram-soak/2026-05-06-historical-full-summary.json)

## 5. Honest boundaries judges should hear

Do not overclaim past these boundaries:

1. AIR OTC is devnet submission-ready, not mainnet production-ready.
2. AIR OTC is trust-minimized and privacy-hardened, not fully trustless.
3. Python PER has real workflow entrypoints, but Python-side Encrypt FHE ciphertext generation is not independently live-proven.
4. Strict PER uses shielded internal credit on devnet, but native SOL entry and exit remain public on Solana.
5. Full automatic Umbra shield / UTXO / claim / unshield is live-recorded for the ElizaOS TypeScript path; SDK-only full-pipeline was attempted on 2026-05-10 and failed closed until real or external Zerion transaction evidence is supplied.
6. Mixed Python/TypeScript live PER is not yet recorded as a devnet proof.
7. The frontend is observatory-only; agents execute through SDK, runtime, or MCP-controlled workflows.

## 6. Submission bundle hygiene

The final public bundle should include source, docs, proof references, and screenshots. It should exclude:

- `.env`, `.env.*`, `.env.production`, private keys, seed phrases, and wallet files
- `node_modules`, `.next`, `dist`, `build`, `target`, `.anchor`, `test-ledger`, and generated caches
- logs, local proof transcripts, `.DS_Store`, temporary files, local databases, and huge raw research artifacts
- historical docs unless they are explicitly marked supporting-only

Use [.submissionignore](/Users/tutul/Downloads/AIR OTC/.submissionignore) as the submission packaging exclusion contract.

## 7. Historical or supporting files

These files can still be useful, but they are not the canonical current-state source of truth:

- [GRANT_APPLICATION_DRAFT.md](/Users/tutul/Downloads/AIR OTC/GRANT_APPLICATION_DRAFT.md)
- [middleman-agent/SUBMISSION_GUIDE.md](/Users/tutul/Downloads/AIR OTC/middleman-agent/SUBMISSION_GUIDE.md)
- mirror files under [/Users/tutul/Downloads/AIR OTC/docs](</Users/tutul/Downloads/AIR OTC/docs>) other than [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)

## 8. Recommended final packet

At minimum, package:

- clean repository link or clean submission archive
- [SUBMISSION_README.md](/Users/tutul/Downloads/AIR OTC/SUBMISSION_README.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
- [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
- [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
- [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
- [docs/HOW_TO_VERIFY.md](/Users/tutul/Downloads/AIR OTC/docs/HOW_TO_VERIFY.md)
- [docs/JUDGE_DEMO_SCRIPT.md](/Users/tutul/Downloads/AIR OTC/docs/JUDGE_DEMO_SCRIPT.md)
- proof ticket IDs and expected proof status
- frontend screenshots for dashboard, explorer, marketplace, agents, and docs
- demo video or demo script
- Colosseum crowdedness screenshot/link and AI subscription proof if required by the submission form
