# Middleman Dependency Audit Notes

Last checked: 2026-05-14

The critical `protobufjs` advisories are mitigated with an npm override to
`protobufjs@7.5.8`. The critical `form-data` advisory from the `aptos` tree is
also mitigated by overriding `form-data` to `4.0.5`.

Residual `npm audit --audit-level=moderate` findings remain in upstream
Solana-agent-kit and DeFi/NFT transitive dependency chains. The highest-impact
remaining groups are:

- `axios <=0.31.0` below `aptos`, `@tensor-hq/tensor-common`, and `wait-on`.
- `bigint-buffer` below older `@solana/web3.js` and `@solana/spl-token` trees.
- `node-fetch@2.6.1` below `@solana/spl-token-registry` through its pinned
  `cross-fetch` tree.
- `langsmith` below `@langchain/core` pulled by `solana-agent-kit`.
- Solana-agent-kit plugin chains that pin vulnerable DeFi/NFT SDK transitive
  packages.

Those residuals require upstream package releases or broader dependency
replacement. This branch intentionally avoids forcing cross-major overrides for
those chains because that would be higher risk than the targeted advisory
mitigations above.
