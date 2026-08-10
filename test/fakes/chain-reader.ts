import { okAsync } from 'neverthrow'
import pino from 'pino'
import { mainnet } from 'viem/chains'
import type { ChainReader } from '../../src/core/chain/reader'
import { createChainRegistry } from '../../src/core/chain/registry'
import type { Address } from '../../src/core/chain/types'
import type { Tool, ToolCtx, ToolFactory } from '../../src/core/mcp/define-tool'

export const silentLogger = pino({ level: 'silent' })

export const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address

export const createFakeReader = (overrides?: Partial<ChainReader>): ChainReader => ({
  chainId: () => okAsync(1n),
  capabilities: () => okAsync({ archive: true, trace: false, batchCap: 3 }),
  pinBlock: () => okAsync({ number: 19000000n, timestamp: 1705000000n }),
  block: () =>
    okAsync({
      number: 19000000n,
      hash: '0xb5a7bcbeb1a9d1a2b0b4b6de3d4a3f6b9a0c1d2e3f405162738495a6b7c8d9e0' as const,
      parentHash: '0xa5a7bcbeb1a9d1a2b0b4b6de3d4a3f6b9a0c1d2e3f405162738495a6b7c8d9e0' as const,
      timestamp: 1705000000n,
      txCount: 2,
      gasUsed: 15000000n,
      gasLimit: 30000000n,
      baseFeePerGasWei: 20000000000n,
      txHashes: [
        '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' as const,
        '0x6c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' as const,
      ],
      txs: null,
    }),
  gasOutlook: () =>
    okAsync({
      baseFeeWei: 20000000000n,
      priorityTiersWei: { slow: 100000000n, standard: 1500000000n, fast: 3000000000n },
      blobBaseFeeWei: 1n,
      syncing: false,
    }),
  l1DataFee: () => okAsync(null),
  account: () =>
    okAsync({ balanceWei: 1500000000000000000n, nonce: 42, isContract: false, delegatedTo: null }),
  resolveName: () => okAsync({ address: VITALIK, hasResolver: true }),
  reverseName: () => okAsync(null),
  tokenInfo: () =>
    okAsync({ name: 'USD Coin', symbol: 'USDC', decimals: 6, totalSupply: 1000000000000000n }),
  tokenBalance: () => okAsync(123456789n),
  transaction: () =>
    okAsync({
      hash: '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' as const,
      status: 'success' as const,
      from: VITALIK,
      to: '0x28C6c06298d514Db089934071355E5743bf21d60' as Address,
      createdContract: null,
      valueWei: 1500000000000000000n,
      nonce: 5,
      txType: 'eip1559',
      gasLimit: 21000n,
      input: '0x' as const,
      maxFeePerGasWei: 30000000000n,
      maxPriorityFeePerGasWei: 1000000000n,
      authorizationList: null,
      maxFeePerBlobGasWei: null,
      blobVersionedHashes: null,
      blobGasUsed: null,
      blobGasPriceWei: null,
      blockNumber: 19000000n,
      gasUsed: 21000n,
      effectiveGasPriceWei: 20000000000n,
      logs: [],
    }),
  transactionRaw: () =>
    okAsync({
      transaction: { hash: '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' },
      receipt: { status: '0x1' },
    }),
  getLogs: () => okAsync([]),
  analyzeFailure: () =>
    okAsync({
      reason: 'reverted with reason: "ERC20: transfer amount exceeds balance"',
      revertData: '0x08c379a0' as const,
      method: 'replay' as const,
      confidence: 'approximate' as const,
      note: null,
    }),
  ...overrides,
})

export const testRegistry = (reader: ChainReader = createFakeReader(), chain = mainnet) =>
  createChainRegistry([{ chain, reader }])

export const buildTool = (factory: ToolFactory, reader?: ChainReader): Tool =>
  factory(testRegistry(reader))

export const testCtx = (reader: ChainReader): ToolCtx => {
  const registry = testRegistry(reader)
  return { resolve: registry.resolve, chains: registry.chains, log: silentLogger }
}
