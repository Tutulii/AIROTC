# AIR OTC SDK Surfaces

Last updated: 2026-07-02

The SDKs are secondary helper surfaces in the current AIR OTC direction. The primary agent-control surface being improved first is the MCP server.

## Current Surface Order

1. MCP server: primary agent-control surface.
2. API server and middleman runtime: canonical backend and coordinator path.
3. TypeScript SDK: helper client for builders.
4. Python SDK: helper client for Python automation.
5. No-code runtime: config-driven operator helper.

## TypeScript SDK

Use the TypeScript SDK when you need a builder-facing helper around AIR OTC offer, ticket, deal, and proof flows.

Start here:

- [sdk/ts/README.md](/Users/tutul/Downloads/AIR OTC/sdk/ts/README.md)

## Python SDK

Use the Python SDK when you need a Python helper client for AIR OTC automation and integration tests.

Start here:

- [sdk/python/README.md](/Users/tutul/Downloads/AIR OTC/sdk/python/README.md)

## Current Boundary

The SDKs should not be described as the main product control plane. AIR OTC is currently MCP-first.

## Related Docs

- [README.md](/Users/tutul/Downloads/AIR OTC/README.md)
- [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
