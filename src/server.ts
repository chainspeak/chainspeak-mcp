import { McpServer } from '@modelcontextprotocol/server'
import type { Deps } from './deps'
import { allTools } from './tools'

export const buildServer = (deps: Deps): McpServer => {
  const server = new McpServer(
    { name: 'chainspeak-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  for (const tool of allTools) {
    tool.register(server, { readerFor: deps.readerFor, log: deps.log })
  }
  return server
}
