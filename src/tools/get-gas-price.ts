import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { weiToGwei } from '../chain/format'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({})

const output = z.object({
  base_fee_wei: z.string().nullable(),
  base_fee_gwei: z.string().nullable(),
  priority_fee_wei: z.string(),
  priority_fee_gwei: z.string(),
  total_fee_wei: z.string().nullable(),
  total_fee_gwei: z.string().nullable(),
})

export const gasPriceHandler = (
  _args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.feeEstimate())
    .map((fee) => {
      const totalWei = fee.baseFeeWei === null ? null : fee.baseFeeWei + fee.maxPriorityFeeWei
      return {
        base_fee_wei: fee.baseFeeWei === null ? null : fee.baseFeeWei.toString(),
        base_fee_gwei: fee.baseFeeWei === null ? null : weiToGwei(fee.baseFeeWei),
        priority_fee_wei: fee.maxPriorityFeeWei.toString(),
        priority_fee_gwei: weiToGwei(fee.maxPriorityFeeWei),
        total_fee_wei: totalWei === null ? null : totalWei.toString(),
        total_fee_gwei: totalWei === null ? null : weiToGwei(totalWei),
      }
    })

export const getGasPrice = defineTool({
  name: 'eth_get_gas_price',
  description:
    'Current gas pricing for a transaction: the latest block base fee, a suggested priority fee (tip), and the likely total price per gas (base + priority) — each as decimal strings in both wei and gwei. eth_get_chain_info also reports the base fee; this tool adds the suggested priority fee and the combined per-gas estimate, so prefer it when the question is what gas costs right now. Wraps eth_getBlockByNumber(latest) and eth_maxPriorityFeePerGas. Base-fee-derived fields are null on pre-EIP-1559 chains.',
  input,
  output,
  idempotent: false,
  handler: gasPriceHandler,
})
