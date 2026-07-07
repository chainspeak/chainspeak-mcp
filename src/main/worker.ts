import { createMcpHandler } from '@modelcontextprotocol/server'
import { loadConfig } from '../config'
import { buildDeps } from '../deps'
import { createWorkerLogger } from '../logger'
import { requireBearer } from '../mcp/http-auth'
import { buildServer } from '../server'

type Fetcher = (req: Request) => Promise<Response>
type WorkerEnv = Record<string, string | undefined>

let cached: Fetcher | undefined

const build = (env: WorkerEnv): Fetcher => {
  const config = loadConfig(env)
  const deps = buildDeps(config, createWorkerLogger(config.LOG_LEVEL))
  const handler = createMcpHandler(() => buildServer(deps))
  const serve: Fetcher = (req) => handler.fetch(req)
  const guarded = config.MCP_AUTH_TOKEN ? requireBearer(config.MCP_AUTH_TOKEN, serve) : serve
  return (req) => {
    const path = new URL(req.url).pathname
    if (path === '/healthz') return Promise.resolve(new Response('ok', { status: 200 }))
    return guarded(req)
  }
}

export default {
  fetch(req: Request, env: WorkerEnv): Promise<Response> {
    cached ??= build(env)
    return cached(req)
  },
}
