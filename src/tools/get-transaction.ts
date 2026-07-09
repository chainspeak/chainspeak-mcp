import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { scaleUnits, weiToGwei } from '../chain/format'
import { HashSchema } from '../chain/types'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({
  tx_hash: HashSchema.describe(
    '0x-prefixed 32-byte transaction hash, e.g. 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  ),
})

const output = z.object({
  found: z.boolean(),
  status: z.enum(['success', 'failed', 'pending']).nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  value_wei: z.string().nullable(),
  value_eth: z.string().nullable(),
  block_number: z.string().nullable(),
  gas_used: z.string().nullable(),
  effective_gas_price_wei: z.string().nullable(),
  effective_gas_price_gwei: z.string().nullable(),
  fee_paid_wei: z.string().nullable(),
  fee_paid_eth: z.string().nullable(),
  log_count: z.number().nullable(),
  note: z.string().nullable(),
})

const notFound: z.output<typeof output> = {
  found: false,
  status: null,
  from: null,
  to: null,
  value_wei: null,
  value_eth: null,
  block_number: null,
  gas_used: null,
  effective_gas_price_wei: null,
  effective_gas_price_gwei: null,
  fee_paid_wei: null,
  fee_paid_eth: null,
  log_count: null,
  note: 'transaction not found — the node does not know this hash; it may never have existed, may have been dropped from the mempool, or may be on a different chain',
}

export const transactionHandler = (
  args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.transaction(args.tx_hash))
    .map((tx) => {
      if (tx === null) return notFound
      const feeWei =
        tx.gasUsed !== null && tx.effectiveGasPriceWei !== null
          ? tx.gasUsed * tx.effectiveGasPriceWei
          : null
      return {
        found: true,
        status: tx.status,
        from: tx.from,
        to: tx.to,
        value_wei: tx.valueWei.toString(),
        value_eth: scaleUnits(tx.valueWei, 18),
        block_number: tx.blockNumber === null ? null : tx.blockNumber.toString(),
        gas_used: tx.gasUsed === null ? null : tx.gasUsed.toString(),
        effective_gas_price_wei:
          tx.effectiveGasPriceWei === null ? null : tx.effectiveGasPriceWei.toString(),
        effective_gas_price_gwei:
          tx.effectiveGasPriceWei === null ? null : weiToGwei(tx.effectiveGasPriceWei),
        fee_paid_wei: feeWei === null ? null : feeWei.toString(),
        fee_paid_eth: feeWei === null ? null : scaleUnits(feeWei, 18),
        log_count: tx.logCount,
        note: null,
      }
    })

export const getTransaction = defineTool({
  name: 'eth_get_transaction',
  description:
    'Summary of a transaction by hash: status (success|failed|pending), from, to (null for contract creation), transferred value in wei and ether, gas used, effective gas price in wei and gwei, total fee paid in wei and ether, block number, and the number of logs it emitted. Log count is a gauge of contract activity — full logs and calldata are NOT returned, to keep responses small. Wraps eth_getTransactionByHash and eth_getTransactionReceipt. A pending transaction has status "pending" and null receipt fields (block_number, gas_used, prices, fee, log_count). found false with an explanatory note means the node does not know the hash — a normal answer, not an error.',
  input,
  output,
  idempotent: false,
  handler: transactionHandler,
})
