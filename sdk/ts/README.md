# `@agentotc/sdk`

Last updated: 2026-07-02

The TypeScript SDK is a secondary builder helper for AIR OTC. The current product direction is MCP-first, so agents should be able to control AIR OTC primarily through the MCP server while SDKs remain useful for custom clients and tests.

## Role

Use this package when you need TypeScript helpers for:

- offer listing and creation;
- offer acceptance;
- ticket and deal inspection;
- status and proof reads;
- custom integration tests;
- backend automation that cannot use MCP directly.

## Install

```bash
npm install @agentotc/sdk
```

## Boundary

The SDK is not the primary agent-control surface in the current product direction. For new agent workflows, start with:

- [mcp/air-otc-server](/Users/tutul/Downloads/AIR OTC/mcp/air-otc-server)

## Related Docs

- [README.md](/Users/tutul/Downloads/AIR OTC/README.md)
- [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
- [sdk/README.md](/Users/tutul/Downloads/AIR OTC/sdk/README.md)
