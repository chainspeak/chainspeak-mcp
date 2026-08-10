import type { Logger } from 'pino'
import { type ChainEntry, type ChainRegistry, createChainRegistry } from './chain/registry'
import { createViemReader } from './chain/viem/client'
import type { AppConfig } from './config'
import { findKnownChain, knownChainNames } from './known-chains'
import { createLogger } from './logger'

export interface Deps {
  registry: ChainRegistry
  log: Logger
}

export const buildDeps = (
  config: AppConfig,
  log: Logger = createLogger(config.LOG_LEVEL),
): Deps => {
  const entries: ChainEntry[] = config.rpcs.map(({ selector, url, fallbackUrl }) => {
    const chain = findKnownChain(selector)
    if (chain === undefined) {
      throw new Error(
        `unknown chain '${selector}' — the bundled server knows: ${knownChainNames()}`,
      )
    }
    return {
      chain,
      reader: createViemReader({
        chain,
        url,
        timeoutMs: config.ETH_RPC_TIMEOUT_MS,
        ...(fallbackUrl !== undefined ? { fallbackUrl } : {}),
      }),
    }
  })

  // CHAIN names the default only when it is actually configured; otherwise the
  // first endpoint wins, so a single RPC_URL_BASE server defaults to base.
  const configured = findKnownChain(config.CHAIN)
  const isConfigured = configured !== undefined && entries.some((e) => e.chain.id === configured.id)

  return {
    registry: createChainRegistry(entries, isConfigured ? { default: config.CHAIN } : {}),
    log,
  }
}
