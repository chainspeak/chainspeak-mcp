#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { verifyChains } from '../core/chain/registry'
import type { AppConfig } from '../core/config'
import { loadConfig } from '../core/config'
import { buildDeps } from '../core/deps'
import { buildServer } from '../core/server'

const loadConfigOrExit = (): AppConfig => {
  try {
    return loadConfig(process.env)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
}

const config = loadConfigOrExit()
const deps = buildDeps(config)

// An endpoint serving a different chain than it is registered as would answer
// confidently and wrongly, so refuse to start. An endpoint that is merely
// unreachable right now is not a misconfiguration: warn and carry on, or a
// flaky RPC at boot would take the whole server down.
const verified = await verifyChains(deps.registry)
if (verified.isErr()) {
  const e = verified.error
  if (e.category === 'INVALID_INPUT') {
    process.stderr.write(`${e.message}\n${e.hint}\n`)
    process.exit(1)
  }
  deps.log.warn({ hint: e.hint }, `could not verify configured chains: ${e.message}`)
}

serveStdio(() => buildServer(deps))
deps.log.info({ chain: deps.registry.defaultChain.spec.key }, 'stdio server started')
