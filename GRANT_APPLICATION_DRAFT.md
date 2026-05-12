# Agentic Engineering Grant Application — AIR OTC

> Historical planning draft
>
> This file is not the canonical current-state source of truth for AIR OTC.
> Before using anything in this draft for a judge packet or submission, read:
> - [NEW_SUBMISSION_CHECKLIST.md](/Users/tutul/Downloads/AIR OTC/NEW_SUBMISSION_CHECKLIST.md)
> - [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
> - [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
> - [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
> - [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)

**Grant Link**: https://superteam.fun/earn/grants/agentic-engineering

**Fixed Grant Amount**: 200 USDG

---

## Step 1: Basics

### Project Title
> AIR OTC: Agent-to-Agent OTC Settlement System

### One Line Description
> An agent-to-agent OTC settlement system built for Solana, enabling autonomous agents to execute encrypted trades with escrow, delivery, and reward settlement—complete with TypeScript SDK, no-code runtime, ElizaOS agents, and read-only observatory frontend.

### TG Username
> t.me/Cryptogk00

### Wallet Address
> FQ2nYvHjM7kJtvDzAK63fWCw528tYDkqhT1QKuJtpe98

---

## Step 2: Details

### Project Details

AIR OTC is a settlement and execution layer for autonomous agents on Solana. The problem it solves is fundamental: agents can now hold wallets, post offers, and negotiate—but they lack a structured settlement mechanism for trades where the traded object is not just a token swap.

**The product architecture** is deliberately split into three public surfaces:

1. **Technical SDKs** — TypeScript and Python SDKs exposing low-level clients (offers, agents, deals, DM) plus workflow layers for both ER (public) and PER (private) trade flows
2. **No-code runtime** — A config-driven CLI (`air-otc init`, `air-otc start`, `air-otc proof`) enabling non-technical operators to run buyer, seller, watcher, or maker roles
3. **Human observatory** — A read-only Next.js frontend with dashboard, marketplace, agent directory, deal explorer, and documentation

**Current flagship flow** is PER (Private Encrypted Release): agents negotiate privately over DM, execute trades with encrypted delivery, settle with post-transaction Torque rewards, and humans only monitor activity through the observatory.

**Why this separation matters**: Agents are the primary economic actors. Execution logic belongs in SDK/runtime flows, not buried in web interfaces. The frontend is most valuable as a trust and observability layer, not a control panel.

### Deadline
> 2026-05-10 (Asia/Calcutta)

### Proof of Work

**Recent Development (Git History)**: 
- Repository: https://github.com/Tutulii/MIDERIAN-TEST.git (Railway: https://github.com/gulbadanjhumur397-web/middleman.git)
- Latest commits include:
  - ✅ Full autonomy experiment (agents can modify 12 autonomous settings)
  - ✅ Autonomous code engine (10 sandboxed tools for code execution)
  - ✅ Resilient price oracle fallback (CoinGecko → Birdeye → GeckoTerminal)
  - ✅ WebSocket+REST on single port for production
  - ✅ Docker deployment (Debian Slim with native dependency fixes)
  - ✅ Prisma migrations and database initialization

**Shipped Components**:

1. **TypeScript SDK** (`sdk/ts/`) — Production build passing
   - Low-level clients: `offers`, `agents`, `deals`, `dm`
   - Workflow layer: `quickBuyEr`, `quickSellEr`, `quickBuyPer`, `quickSellPer`, `runBuyerFlow`, `runSellerFlow`
   - Build: `npm run build` ✅

2. **Python SDK** (`sdk/python/`) — Production build passing
   - Low-level surfaces: agent, offer, deal
   - ER workflow helpers + PER workflow namespace
   - Compile check: `python3 -m compileall sdk/python/agentotc/src/agentotc` ✅

3. **ElizaOS Agent** (`agents/elizaos-agent/`)
   - 8 autonomous actions (POST_OFFER, BROWSE_OFFERS, ACCEPT_OFFER, NEGOTIATE_TERMS, DEPOSIT_COLLATERAL, CONFIRM_DELIVERY, APPROVE_RELEASE, OPEN_DISPUTE)
   - Smart context injection via `airotcProvider.ts`
   - Dual role support (buyer/seller CLI flags)
   - Dual mode support (ER and PER paths)
   - WebSocket event-driven architecture (no polling)
   - Full end-to-end deal lifecycle with graceful error handling

4. **No-code Runtime** (`runtime/air-otc/`)
   - `air-otc init` — Config wizard
   - `air-otc validate` — Config validation
   - `air-otc start` — Start agent
   - `air-otc start --role buyer|seller|watcher|maker` — Role selection
   - `air-otc proof pair` — Proof generation
   - YAML config-driven (`agentotc.config.yaml`)

5. **Observatory Frontend** (`frontend/`)
   - Routes: `/` (Dashboard), `/explorer` (Deal explorer), `/marketplace` (Offer board), `/agents` (Directory), `/docs` (Quickstart)
   - Read-only observatory design (humans observe, agents execute)
   - Build: `npm run build` ✅

**Documentation & Whitepapers**:
- `AIROTC_WHITEPAPER.md` — Full product model and design philosophy
- `AIROTC_ARCHITECTURE.md` — System diagram and module map
- `PROJECT_STATUS.md` — Verified commands and implementation status
- `ELIZAOS_DELIVERY.md` — ElizaOS agent quick start and end-to-end testing
- `ELIZAOS_RULES_VERIFICATION.md` — Compliance and autonomy verification

**Deployed & Observable**:
- API Server (`api-server/`) — Production deployment-ready with PRODUCTION_READINESS.md audit
- Escrow Programs (`escrow/`) — Anchor programs with Security Audit (`SECURITY_AUDIT.md`)
- Integration Tests (`tests/`) — End-to-end verification
- Example agent configs (`runtime/air-otc/agentotc.config.example.yaml`)

### Personal X Profile
> x.com/cryptogk00

### Personal GitHub Profile
> github.com/Tutulii

### Colosseum Crowdedness Score
> ⚠️ **ACTION REQUIRED**: Visit https://colosseum.com/copilot, search for your project "AIR OTC", take a screenshot of the Crowdedness Score, upload it to a publicly accessible Google Drive or link, and paste the link here.
>
> _Note: This score measures how crowded the market is for your project idea. Grant reviewers use it to assess market opportunity._

### AI Session Transcript
> **File**: `./codex-session.jsonl` (in project root)
>
> This file contains the full AI development session transcript showing how the project was built, debugged, and iterated using AI assistance. The file is at:
> ```
> /Users/tutul/Downloads/AIR OTC/codex-session.jsonl
> ```
>
> **How to attach**: Download this file from your project and upload it to the Superteam grant form when submitting.

---

## Step 3: Milestones

### Goals and Milestones

**Milestone 1 (By 2026-05-08)**: Eliza Integration Completion & Mainnet Readiness
- Complete ElizaOS agent autonomy audit (verify all 8 actions execute without manual intervention)
- Deploy escrow programs to mainnet (currently on devnet)
- Finalize security audit sign-off for smart contracts
- Expected KPI: 100% action execution success rate in end-to-end test

**Milestone 2 (By 2026-05-08)**: SDK Feature Parity
- Verify TypeScript SDK handles all ER and PER workflow paths
- Verify Python SDK API surface matches TypeScript (feature parity)
- Deploy SDKs to NPM and PyPI with documentation
- Expected KPI: 0 API discrepancies between SDKs

**Milestone 3 (By 2026-05-09)**: Observatory Frontend & Documentation
- Deploy observatory frontend to production (currently staging)
- Update all integration docs (TypeScript, Python, No-code runtime, ElizaOS)
- Publish quick-start guides for each surface (technical, no-code, observatory)
- Expected KPI: Average doc page load time < 2s, all routes working

**Milestone 4 (By 2026-05-09)**: No-code Runtime Public Release
- Publish `air-otc` CLI to NPM as `@airotc/runtime`
- Publish example config templates and setup wizards
- End-to-end test: new user can run `air-otc init` → `air-otc start` in < 5 minutes
- Expected KPI: 5+ successful test user onboarding runs

**Milestone 5 (By 2026-05-10)**: Community Agents & First Live Trades
- Deploy 3+ example ElizaOS agents to live testnet
- Facilitate first peer-to-peer PER trades with encrypted settlement
- Measure and verify settlement latency (target: < 10s deal confirmation)
- Expected KPI: 2+ successful live ER trades, 1+ successful live PER trade

### Primary KPI
> **Daily Active Agents (DAA) on Mainnet**: Number of unique agent wallets executing at least one trade (offer post, offer acceptance, deal settlement) per day on mainnet, measured 30 days post-launch.
>
> **Target**: 10+ daily active agents by end of grant period.

### Final Tranche Checklist
> To receive the final tranche payment, you must submit:
>
> ✅ **Colosseum Project Link** — Your public Colosseum project page showing the crowdedness score
> ✅ **GitHub Repository** — Public repo link (https://github.com/Tutulii/MIDERIAN-TEST.git or equivalent)
> ✅ **AI Subscription Receipt** — Proof of active Claude/AI subscription during development (Claude Code, Codex, etc.)
>
> These items are bundled in the final submission form. Save this checklist for reference at payment time.

---

## How to Submit

1. **Go to**: https://superteam.fun/earn/grants/agentic-engineering
2. **Fill out the form using the sections above** — Copy-paste the values from the `>` blockquotes
3. **Attach your session transcript** — Upload `./codex-session.jsonl` from your project root
4. **Get Colosseum score** — Visit https://colosseum.com/copilot, search "AIR OTC", take a screenshot, upload it
5. **Review & Submit** — Double-check all fields, then click Submit

---

## Questions?

If you need to iterate on any section:
- **Project Title/Description**: Edit the one-liners or project details section
- **Milestones**: Adjust dates or KPIs based on your actual timeline
- **Proof of Work**: Add more links, demos, or deployed instances
- **TG/Wallet/X**: Provide updated contact info

Just ask and we'll refine before you submit!

---

**Last updated**: 2026-05-04
**Submission deadline**: Check Superteam Earn page for latest cutoff dates
