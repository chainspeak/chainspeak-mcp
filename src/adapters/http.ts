#!/usr/bin/env node
import { createServer } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { verifyChains } from '../core/chain/registry'
import { loadConfig } from '../core/config'
import { buildDeps } from '../core/deps'
import { requireBearer } from '../core/mcp/http-auth'
import { buildServer } from '../core/server'

const main = (): void => {
  const config = loadConfig(process.env)
  const deps = buildDeps(config)
  const handler = createMcpHandler(() => buildServer(deps))
  const serve = (req: Request): Promise<Response> => handler.fetch(req)
  const guarded = config.MCP_AUTH_TOKEN ? requireBearer(config.MCP_AUTH_TOKEN, serve) : serve
  if (!config.MCP_AUTH_TOKEN) {
    deps.log.warn(
      'MCP_AUTH_TOKEN is not set — the HTTP server is UNAUTHENTICATED; anyone who can reach it can use your RPC endpoint',
    )
  }

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
    deps.log.info(
      {
        host: config.HTTP_HOST,
        port: config.HTTP_PORT,
        chain: deps.registry.defaultChain.spec.key,
      },
      'http server started',
    )
  })
  void verifyChains(deps.registry).mapErr((e) => {
    if (e.category !== 'INVALID_INPUT') {
      deps.log.warn({ hint: e.hint }, `could not verify configured chains: ${e.message}`)
      return
    }
    deps.log.error({ hint: e.hint }, e.message)
    process.exit(1)
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
