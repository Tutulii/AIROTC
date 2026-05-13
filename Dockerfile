FROM node:20-slim

WORKDIR /app

# AIR OTC MCP is deployed from the repository root because it needs the local
# TypeScript SDK build for PER workflow tools.
COPY sdk/ts/package*.json ./sdk/ts/
RUN cd sdk/ts && npm ci --include=dev

COPY middleman-agent/package*.json ./middleman-agent/
RUN cd middleman-agent && npm ci --include=dev --legacy-peer-deps

COPY mcp/air-otc-server/package*.json ./mcp/air-otc-server/
RUN cd mcp/air-otc-server && npm ci --include=dev

COPY sdk/ts ./sdk/ts
COPY middleman-agent/src ./middleman-agent/src
COPY middleman-agent/agents/sdk/MeridianClient.ts ./middleman-agent/agents/sdk/MeridianClient.ts
RUN cd sdk/ts && npm run build

COPY mcp/air-otc-server ./mcp/air-otc-server
RUN cd mcp/air-otc-server && npm run build

ENV AIR_OTC_TS_SDK_PATH=/app/sdk/ts/dist/index.mjs
ENV AIR_OTC_MCP_PORT=8787

EXPOSE 8787

CMD ["node", "mcp/air-otc-server/dist/index.js", "--http"]
