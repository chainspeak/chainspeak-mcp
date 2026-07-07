module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'viem-only-in-adapter',
      comment: 'viem is a vendor detail; only the adapter may import it',
      severity: 'error',
      from: { pathNot: '^src/chain/viem' },
      to: { path: 'node_modules/viem' },
    },
    {
      name: 'mcp-sdk-only-at-edge',
      comment: 'the MCP SDK is importable only from src/mcp, src/server.ts and entries',
      severity: 'error',
      from: { pathNot: '^src/(mcp|main)|^src/server\\.ts$' },
      to: { path: 'node_modules/@modelcontextprotocol' },
    },
    {
      name: 'chain-port-is-pure',
      comment: 'the domain port must not know about tools, mcp glue, or entries',
      severity: 'error',
      from: { path: '^src/chain', pathNot: '^src/chain/viem' },
      to: { path: '^src/(tools|mcp|main)|^src/server\\.ts$' },
    },
    {
      name: 'tools-use-port-only',
      comment: 'tools may not reach the adapter, entries, or server assembly',
      severity: 'error',
      from: { path: '^src/tools' },
      to: { path: '^src/(chain/viem|main)|^src/server\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
