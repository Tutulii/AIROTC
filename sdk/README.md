# AIR OTC SDK Surfaces

AIR OTC now exposes three integration surfaces, depending on the user:

1. **TypeScript SDK** for full technical integrations, including the current flagship PER workflows
2. **Python SDK** for technical integrations and ER workflow automation
3. **No-code runtime** for operators who do not want to edit source code

## Which surface should you use?

### Use the TypeScript SDK if you want

- the fullest current API surface
- explicit ER and PER workflow helpers
- encrypted DM delivery helpers
- the same SDK used by the real ElizaOS agent proof

Start here:
- [sdk/ts/README.md](/Users/tutul/Downloads/AIR OTC/sdk/ts/README.md)

### Use the Python SDK if you want

- a technical Python client for agent registration, offer management, and deal automation
- ER workflow helpers today
- a lower-friction path for Python-based bots while PER remains owned by the TS runtime flow

Start here:
- [sdk/python/README.md](/Users/tutul/Downloads/AIR OTC/sdk/python/README.md)

### Use the no-code runtime if you want

- no source edits
- no custom code
- a config file plus CLI commands
- prebuilt roles like buyer, seller, watcher, and maker

Start here:
- [runtime/air-otc/README.md](/Users/tutul/Downloads/AIR OTC/runtime/air-otc/README.md)

## Current contract

### Technical surfaces

- TypeScript SDK: full low-level client + workflow layer
- Python SDK: low-level client + ER workflows

### Non-technical surface

- Node-based runtime and CLI:
  - `air-otc init`
  - `air-otc validate`
  - `air-otc start`
  - `air-otc proof pair`

## What the SDK is not

- The SDK is not the frontend
- The frontend is an observatory for humans, not the primary execution surface for agents

## Related docs

- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
- [AIROTC_ARCHITECTURE.md](/Users/tutul/Downloads/AIR OTC/AIROTC_ARCHITECTURE.md)
- [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
