import { McpServer } from '@modelcontextprotocol/server'
import type { Deps } from './deps'
import { createTools } from './tools'

export const buildServer = (deps: Deps): McpServer => {
  const server = new McpServer(
    { name: 'chainspeak-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  const ctx = {
    resolve: deps.registry.resolve,
    chains: deps.registry.chains,
    log: deps.log,
  }
  for (const tool of createTools(deps.registry)) {
    tool.register(server, ctx)
  }
  return server
}
