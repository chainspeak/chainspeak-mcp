import { isAddress } from 'viem'
import * as z from 'zod'

export type Address = `0x${string}`

export type Hash = `0x${string}`

export const BLOCK_TAGS = ['latest', 'safe', 'finalized', 'earliest'] as const
export type BlockTag = (typeof BLOCK_TAGS)[number]

export type BlockRef = BlockTag | bigint

/**
 * A mixed-case address carries a checksum, so a typo is detectable and MUST be
 * rejected: lowercasing it would name a different, existing-looking account.
 */
const CHECKSUM_HINT =
  'this address is mixed-case, so it carries an EIP-55 checksum, and the checksum does not match — one or more characters are wrong; copy the address again from its source, or pass it all-lowercase if you know it is correct'

const isChecksummed = (s: string): boolean => {
  const body = s.slice(2)
  return /[a-f]/.test(body) && /[A-F]/.test(body)
}

export const checksumValid = (s: string): boolean =>
  !isChecksummed(s) || isAddress(s, { strict: true })

export const AddressSchema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{40}$/,
    'expected a 42-character 0x-prefixed hex address, e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  )
  .refine(checksumValid, CHECKSUM_HINT)
  .transform((s): Address => s.toLowerCase() as Address)

export const HashSchema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{64}$/,
    'expected a 66-character 0x-prefixed transaction hash, e.g. 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  )
  .transform((s): Hash => s.toLowerCase() as Hash)

export const ENS_NAME_PATTERN = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/

export const AddressOrNameSchema = z
  .string()
  .refine(
    (s) => /^0x/i.test(s) === false || /^0x[0-9a-fA-F]{40}$/.test(s),
    'a 0x-prefixed value must be a full 42-character hex address',
  )
  .refine(
    (s) => /^0x/i.test(s) || ENS_NAME_PATTERN.test(s),
    'expected a 0x address or a dotted ENS name, e.g. vitalik.eth — Unicode names must be given in normalized ASCII (punycode) form',
  )
  .refine((s) => !/^0x/i.test(s) || checksumValid(s), CHECKSUM_HINT)
  .transform((s) => s.toLowerCase())

export const isAddressInput = (s: string): s is Address => /^0x/i.test(s)

export const BlockRefSchema = z
  .union([
    z.enum(BLOCK_TAGS),
    z
      .string()
      .regex(
        /^(\d+|0x[0-9a-fA-F]+)$/,
        'expected a decimal or 0x-hex block number, e.g. 19000000 or 0x121eac0',
      ),
  ])
  .transform((s): BlockRef => (BLOCK_TAGS.includes(s as BlockTag) ? (s as BlockTag) : BigInt(s)))

export interface PinnedBlock {
  number: bigint
  timestamp: bigint
}

export interface AccountState {
  balanceWei: bigint
  nonce: number
  /** true for real contract code; false for EOAs, including EIP-7702-delegated ones */
  isContract: boolean
  /** EIP-7702: the address this EOA delegates its code to, null when not delegated */
  delegatedTo: Address | null
}

export interface NameResolution {
  address: Address | null
}

export interface TokenInfo {
  name: string | null
  symbol: string | null
  decimals: number | null
  totalSupply: bigint | null
}

export type TxStatus = 'success' | 'failed' | 'pending'

export interface LogEntry {
  address: Address
  topics: readonly `0x${string}`[]
  data: `0x${string}`
  logIndex: number
}

export interface TransactionData {
  hash: Hash
  status: TxStatus
  from: Address
  to: Address | null
  createdContract: Address | null
  valueWei: bigint
  nonce: number
  txType: string
  gasLimit: bigint
  input: `0x${string}`
  maxFeePerGasWei: bigint | null
  maxPriorityFeePerGasWei: bigint | null
  /** EIP-7702: the delegations this transaction authorised */
  authorizationList: readonly { chainId: string; address: Address; nonce: string }[] | null
  /** EIP-4844: blob gas is an INDEPENDENT fee market, not part of execution gas */
  maxFeePerBlobGasWei: bigint | null
  blobVersionedHashes: readonly `0x${string}`[] | null
  blockNumber: bigint | null
  gasUsed: bigint | null
  effectiveGasPriceWei: bigint | null
  blobGasUsed: bigint | null
  blobGasPriceWei: bigint | null
  logs: LogEntry[] | null
}

/** eth_getLogs filter; topics follow the JSON-RPC convention (null = wildcard, array = OR). */
export interface LogFilter {
  address?: Address
  topics?: readonly (`0x${string}` | readonly `0x${string}`[] | null)[]
  fromBlock: bigint
  toBlock: bigint
}

export interface RangeLog {
  address: Address
  topics: readonly `0x${string}`[]
  data: `0x${string}`
  blockNumber: bigint
  txHash: Hash
  logIndex: number
}

export interface FailureAnalysis {
  reason: string | null
  revertData: `0x${string}` | null
  method: 'trace' | 'replay' | 'none'
  confidence: 'exact' | 'approximate' | 'none'
  /** Silent fallback is a bug; this field is the receipt for a degraded path. */
  note: string | null
}

export interface BlockTx {
  hash: Hash
  from: Address
  to: Address | null
  valueWei: bigint
  nonce: number
  txType: string
}

export interface BlockData {
  number: bigint
  hash: Hash
  parentHash: Hash
  timestamp: bigint
  txCount: number
  gasUsed: bigint
  gasLimit: bigint
  baseFeePerGasWei: bigint | null
  txHashes: readonly Hash[]
  txs: BlockTx[] | null
}

export interface GasOutlook {
  baseFeeWei: bigint | null
  /** priority-fee tiers from recent fee history; null on pre-EIP-1559 chains */
  priorityTiersWei: { slow: bigint; standard: bigint; fast: bigint } | null
  blobBaseFeeWei: bigint | null
  syncing: boolean
}
