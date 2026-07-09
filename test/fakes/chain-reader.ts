import { ok, okAsync } from 'neverthrow'
import pino from 'pino'
import type { ChainReader } from '../../src/chain/reader'
import type { Address } from '../../src/chain/types'
import type { ToolCtx } from '../../src/mcp/define-tool'

export const silentLogger = pino({ level: 'silent' })

export const createFakeReader = (overrides?: Partial<ChainReader>): ChainReader => ({
  chainInfo: () => okAsync({ chainId: 1n, latestBlock: 19000000n, baseFeeWei: 20000000000n }),
  balance: () => okAsync(1500000000000000000n),
  tokenBalance: () => okAsync({ raw: 123456789n, decimals: 6, symbol: 'USDC', name: 'USD Coin' }),
  transaction: () =>
    okAsync({
      status: 'success' as const,
      from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as Address,
      to: '0x28c6c06298d514db089934071355e5743bf21d60' as Address,
      valueWei: 1500000000000000000n,
      blockNumber: 19000000n,
      gasUsed: 21000n,
      effectiveGasPriceWei: 20000000000n,
      logCount: 0,
    }),
  resolveEns: () => okAsync('0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as Address),
  feeEstimate: () => okAsync({ baseFeeWei: 20000000000n, maxPriorityFeeWei: 1500000000n }),
  ...overrides,
})

export const testCtx = (reader: ChainReader): ToolCtx => ({
  readerFor: () => ok(reader),
  log: silentLogger,
})
