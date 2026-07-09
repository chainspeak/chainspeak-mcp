import * as z from 'zod'

export type Address = `0x${string}`

export type Hash = `0x${string}`

export const BLOCK_TAGS = ['latest', 'safe', 'finalized', 'earliest'] as const
export type BlockTag = (typeof BLOCK_TAGS)[number]

export type BlockRef = BlockTag | bigint

export const AddressSchema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{40}$/,
    'expected a 42-character 0x-prefixed hex address, e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  )
  .transform((s): Address => s.toLowerCase() as Address)

export const HashSchema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{64}$/,
    'expected a 66-character 0x-prefixed transaction hash, e.g. 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  )
  .transform((s): Hash => s.toLowerCase() as Hash)

export const EnsNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/,
    'expected a dotted ENS name of ASCII letters, digits, and hyphens, e.g. vitalik.eth',
  )
  .transform((s) => s.toLowerCase())

export const BlockRefSchema = z
  .union([
    z.enum(BLOCK_TAGS),
    z.string().regex(/^\d+$/, 'expected a decimal block number, e.g. 19000000'),
  ])
  .transform((s): BlockRef => (BLOCK_TAGS.includes(s as BlockTag) ? (s as BlockTag) : BigInt(s)))

export interface ChainInfo {
  chainId: bigint
  latestBlock: bigint
  baseFeeWei: bigint | null
}

export interface TokenBalance {
  raw: bigint
  decimals: number | null
  symbol: string | null
  name: string | null
}

export type TxStatus = 'success' | 'failed' | 'pending'

export interface TransactionSummary {
  status: TxStatus
  from: Address
  to: Address | null
  valueWei: bigint
  blockNumber: bigint | null
  gasUsed: bigint | null
  effectiveGasPriceWei: bigint | null
  logCount: number | null
}

export interface FeeEstimate {
  baseFeeWei: bigint | null
  maxPriorityFeeWei: bigint
}
