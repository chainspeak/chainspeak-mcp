import { okAsync, type ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { scaleUnits, weiToGwei } from '../chain/format'
import { BLOCK_TAGS, type BlockRef, type BlockTag, type Hash } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'

const BlockOrHashSchema = z
  .string()
  .regex(
    /^(latest|safe|finalized|earliest|\d+|0x[0-9a-fA-F]+)$/,
    'expected a block tag (latest|safe|finalized|earliest), a decimal or 0x-hex block number, or a 0x-prefixed 32-byte block hash',
  )
  .refine(
    (s) => !/^0x/.test(s) || /^0x([0-9a-fA-F]{1,16}|[0-9a-fA-F]{64})$/.test(s),
    'a 0x value must be either a block number (short hex) or a full 66-character block hash',
  )
  .transform((s): BlockRef | { hash: Hash } => {
    if (BLOCK_TAGS.includes(s as BlockTag)) return s as BlockTag
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { hash: s.toLowerCase() as Hash }
    return BigInt(s)
  })

const input = z.object({
  block: BlockOrHashSchema.default('latest').describe(
    'block tag (latest|safe|finalized|earliest), decimal or 0x-hex block number (e.g. 19000000 or 0x121eac0), or 0x-prefixed 32-byte block hash; default latest',
  ),
  detail: z
    .enum(['summary', 'tx_hashes', 'full_txs'])
    .default('summary')
    .describe(
      'summary (default): header facts only; tx_hashes: adds the transaction hash list; full_txs: adds per-transaction from/to/value/nonce/type — both lists are paginated with limit + cursor',
    ),
  limit: z
    .int()
    .min(1)
    .max(200)
    .default(100)
    .describe('page size for tx_hashes/full_txs lists, 1-200; default 100'),
  cursor: z
    .string()
    .regex(/^\d+$/, 'cursor is the opaque string from a previous response, e.g. "100"')
    .optional()
    .describe('continuation cursor from the previous page (pagination.next_cursor)'),
})

const blockTx = z.object({
  hash: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  value_wei: z.string(),
  value_native: z.string(),
  nonce: z.number(),
  tx_type: z.string(),
})

const pagination = z.object({
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
  next_cursor: z.string().nullable(),
  message: z.string().nullable(),
})

const output = z.object({
  chain_id: z.string(),
  block_number: z.string(),
  found: z.boolean(),
  hash: z.string().nullable(),
  parent_hash: z.string().nullable(),
  timestamp_unix: z.string().nullable(),
  timestamp_iso: z.string().nullable(),
  tx_count: z.number().nullable(),
  gas_used: z.string().nullable(),
  gas_limit: z.string().nullable(),
  gas_used_percent: z.string().nullable(),
  base_fee_wei: z.string().nullable(),
  base_fee_gwei: z.string().nullable(),
  tx_hashes: z.array(z.string()).nullable(),
  transactions: z.array(blockTx).nullable(),
  pagination: pagination.nullable(),
  note: z.string().nullable(),
})

type Out = z.output<typeof output>

const page = <T>(
  items: readonly T[],
  offset: number,
  limit: number,
  what: string,
): { slice: T[]; pagination: z.output<typeof pagination> } => {
  const slice = items.slice(offset, offset + limit)
  const nextOffset = offset + limit
  const next = nextOffset < items.length ? String(nextOffset) : null
  return {
    slice,
    pagination: {
      total: items.length,
      offset,
      limit,
      next_cursor: next,
      message:
        next === null
          ? null
          : `showing ${what} ${offset + 1}-${offset + slice.length} of ${items.length}; pass cursor "${next}" to continue, or raise limit (max 200)`,
    },
  }
}

export const blockHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r, spec }) =>
    r.chainId().andThen((chainId) =>
      r.block(args.block, { fullTxs: args.detail === 'full_txs' }).andThen((b) => {
        if (b === null) {
          return r.pinBlock('latest').map(
            (head): Out => ({
              chain_id: chainId.toString(),
              block_number: head.number.toString(),
              found: false,
              hash: null,
              parent_hash: null,
              timestamp_unix: null,
              timestamp_iso: null,
              tx_count: null,
              gas_used: null,
              gas_limit: null,
              gas_used_percent: null,
              base_fee_wei: null,
              base_fee_gwei: null,
              tx_hashes: null,
              transactions: null,
              pagination: null,
              note: 'block not found — the number is beyond the current head (echoed in block_number), or the hash is unknown to this node; it may also be on a different chain',
            }),
          )
        }
        const offset = args.cursor === undefined ? 0 : Number(args.cursor)
        const base: Out = {
          chain_id: chainId.toString(),
          block_number: b.number.toString(),
          found: true,
          hash: b.hash,
          parent_hash: b.parentHash,
          timestamp_unix: b.timestamp.toString(),
          timestamp_iso: new Date(Number(b.timestamp) * 1000).toISOString(),
          tx_count: b.txCount,
          gas_used: b.gasUsed.toString(),
          gas_limit: b.gasLimit.toString(),
          gas_used_percent:
            b.gasLimit === 0n ? null : (Number((b.gasUsed * 10000n) / b.gasLimit) / 100).toFixed(2),
          base_fee_wei: b.baseFeePerGasWei === null ? null : b.baseFeePerGasWei.toString(),
          base_fee_gwei: b.baseFeePerGasWei === null ? null : weiToGwei(b.baseFeePerGasWei),
          tx_hashes: null,
          transactions: null,
          pagination: null,
          note: null,
        }
        if (args.detail === 'tx_hashes') {
          const { slice, pagination: p } = page(b.txHashes, offset, args.limit, 'tx hashes')
          return okAsync({ ...base, tx_hashes: [...slice], pagination: p })
        }
        if (args.detail === 'full_txs' && b.txs !== null) {
          const { slice, pagination: p } = page(b.txs, offset, args.limit, 'transactions')
          return okAsync({
            ...base,
            transactions: slice.map((t) => ({
              hash: t.hash,
              from: t.from,
              to: t.to,
              value_wei: t.valueWei.toString(),
              value_native: scaleUnits(t.valueWei, spec.native.decimals),
              nonce: t.nonce,
              tx_type: t.txType,
            })),
            pagination: p,
          })
        }
        return okAsync(base)
      }),
    ),
  )

export const getBlock = defineTool({
  name: 'chainspeak_get_block',
  description:
    'Inspect a block by number, tag, or block hash: header facts (hash, parent, timestamp as both unix string and ISO), transaction count, gas_used and gas_limit with gas_used_percent (how full the block was), and base fee in wei and gwei. detail opts into more: tx_hashes lists the transaction hashes, full_txs adds from/to/value/nonce/type per transaction — both lists are paginated (limit, default 100, max 200; continue with pagination.next_cursor) and truncation is always announced in pagination.message, never silent. For everything about ONE transaction use chainspeak_get_transaction. Wraps eth_getBlockByNumber / eth_getBlockByHash. Every response echoes chain_id and block_number (the block itself when found, the current head when not); addresses are EIP-55 checksummed; timestamps and gas values are decimal strings. found false with a note is a normal answer for an unknown hash or a not-yet-mined block number, not an error.',
  input,
  output,
  idempotent: false,
  handler: blockHandler,
})
