module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-never-imports-adapters',
      comment: 'core is the portable library; platform entries depend on it, never the reverse',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'mcp-sdk-only-at-edge',
      comment: 'the MCP SDK is importable only from core/mcp, core/server.ts and adapters',
      severity: 'error',
      from: { pathNot: '^src/core/mcp|^src/core/server\\.ts$|^src/adapters' },
      to: { path: 'node_modules/@modelcontextprotocol' },
    },
    {
      name: 'chain-port-is-pure',
      comment: 'the domain port must not know about tools, mcp glue, or entries',
      severity: 'error',
      from: { path: '^src/core/chain', pathNot: '^src/core/chain/viem' },
      to: { path: '^src/core/(tools|mcp)|^src/core/server\\.ts$|^src/adapters' },
    },
    {
      name: 'tools-use-port-only',
      comment: 'tools may not reach the viem client, entries, or server assembly',
      severity: 'error',
      from: { path: '^src/core/tools' },
      to: { path: '^src/core/chain/viem|^src/adapters|^src/core/server\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
