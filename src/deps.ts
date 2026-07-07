import { err, ok } from 'neverthrow'
import type { Logger } from 'pino'
import { invalidInputError } from './chain/errors'
import { createViemReader } from './chain/viem/client'
import type { AppConfig } from './config'
import { createLogger } from './logger'
import type { ToolCtx } from './mcp/define-tool'

export interface Deps {
  readerFor: ToolCtx['readerFor']
  log: Logger
}

export const buildDeps = (
  config: AppConfig,
  log: Logger = createLogger(config.LOG_LEVEL),
): Deps => {
  const reader = createViemReader({
    url: config.ETH_RPC_URL,
    timeoutMs: config.ETH_RPC_TIMEOUT_MS,
    ...(config.ETH_RPC_URL_FALLBACK !== undefined
      ? { fallbackUrl: config.ETH_RPC_URL_FALLBACK }
      : {}),
  })
  const readerFor: ToolCtx['readerFor'] = (chain) => {
    if (chain !== undefined && chain !== 'ethereum') {
      return err(invalidInputError(`unknown chain '${chain}'; only 'ethereum' is configured`))
    }
    return ok(reader)
  }
  return { readerFor, log }
}
