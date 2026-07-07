import { ok, okAsync } from 'neverthrow'
import pino from 'pino'
import type { ChainReader } from '../../src/chain/reader'
import type { ToolCtx } from '../../src/mcp/define-tool'

export const silentLogger = pino({ level: 'silent' })

export const createFakeReader = (overrides?: Partial<ChainReader>): ChainReader => ({
  chainInfo: () => okAsync({ chainId: 1n, latestBlock: 19000000n, baseFeeWei: 20000000000n }),
  balance: () => okAsync(1500000000000000000n),
  tokenBalance: () => okAsync({ raw: 123456789n, decimals: 6, symbol: 'USDC', name: 'USD Coin' }),
  ...overrides,
})

export const testCtx = (reader: ChainReader): ToolCtx => ({
  readerFor: () => ok(reader),
  log: silentLogger,
})
