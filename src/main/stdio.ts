#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { AppConfig } from '../config'
import { loadConfig } from '../config'
import { buildDeps } from '../deps'
import { buildServer } from '../server'

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
serveStdio(() => buildServer(deps))
deps.log.info('stdio server started')
