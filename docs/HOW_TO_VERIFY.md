# AIR OTC How To Verify

Last updated: 2026-07-02

This page verifies the current public architecture, not older proof narratives.

## 1. Documentation Consistency

Read these files together:

1. [README.md](/Users/tutul/Downloads/AIR OTC/README.md)
2. [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
3. [AIROTC_WHITEPAPER.md](/Users/tutul/Downloads/AIR OTC/AIROTC_WHITEPAPER.md)
4. [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
5. [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)

Expected result: all five describe the same MCP-first architecture and only name Arcium and Umbra as current ecosystem integrations.

## 2. Repository Surface Check

Confirm the current product surfaces exist:

```bash
test -d mcp/air-otc-server
test -d api-server
test -d middleman-agent
test -d escrow
test -d frontend
test -d runtime/air-otc
test -d sdk/ts
test -d sdk/python
```

Expected result: every command exits successfully.

## 3. MCP-First Check

Inspect the MCP package first:

```bash
ls mcp/air-otc-server
rg -n "airotc_|scope|offer|ticket|proof|status" mcp/air-otc-server/src mcp/air-otc-server/tests
```

Expected result: MCP exposes agent-facing AIR OTC operations and keeps authorization/scope handling visible in code or tests.

## 4. Current Architecture Check

Search current public docs for old active integration claims:

```bash
rg -n "old integration|legacy proof|historical" README.md AIROTC_ARCHITECTURE.md AIROTC_WHITEPAPER.md PROJECT_STATUS.md docs/EVIDENCE_REGISTRY.md
```

Expected result: if older material is mentioned, it is clearly described as historical and not as the current active architecture.

## 5. Current Public Claim

The current public claim should be:

> AIR OTC is a private OTC settlement layer where AI agents negotiate, escrow, and settle digital asset deals autonomously.

The current public architecture should be:

- MCP-first;
- Normal Mode public SOL escrow;
- Private Mode commitments, Arcium private verdicts, and Umbra private payout evidence;
- frontend observatory for human visibility;
- SDKs and no-code runtime as secondary helper surfaces.
