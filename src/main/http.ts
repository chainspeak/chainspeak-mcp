#!/usr/bin/env node
import { createServer } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { loadConfig } from '../config'
import { buildDeps } from '../deps'
import { requireBearer } from '../mcp/http-auth'
import { buildServer } from '../server'

const main = (): void => {
  const config = loadConfig(process.env)
  if (!config.MCP_AUTH_TOKEN) {
    throw new Error(
      'MCP_AUTH_TOKEN is required for the HTTP server: it exposes your RPC endpoint on the ' +
        'network. Set a token of at least 16 characters and send it as "Authorization: Bearer <token>".',
    )
  }
  const token = config.MCP_AUTH_TOKEN
  const deps = buildDeps(config)
  const handler = createMcpHandler(() => buildServer(deps))
  const guarded = requireBearer(token, (req) => handler.fetch(req))

  const nodeHandler = toNodeHandler({
    fetch: (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname
      if (path === '/healthz') return Promise.resolve(new Response('ok', { status: 200 }))
      return guarded(req)
    },
  })

  type NodeReq = Parameters<typeof nodeHandler>[0]
  type NodeRes = Parameters<typeof nodeHandler>[1]
  const server = createServer((req, res) => {
    void nodeHandler(req as unknown as NodeReq, res as unknown as NodeRes)
  })
  server.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
    deps.log.info({ host: config.HTTP_HOST, port: config.HTTP_PORT }, 'http server started')
  })

  const shutdown = (): void => {
    deps.log.info('shutting down')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

try {
  main()
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}
