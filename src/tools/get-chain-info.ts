import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { weiToGwei } from '../chain/format'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({})

const output = z.object({
  chain_id: z.string(),
  latest_block: z.string(),
  base_fee_wei: z.string().nullable(),
  base_fee_gwei: z.string().nullable(),
})

export const chainInfoHandler = (
  _args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.chainInfo())
    .map((info) => ({
      chain_id: info.chainId.toString(),
      latest_block: info.latestBlock.toString(),
      base_fee_wei: info.baseFeeWei === null ? null : info.baseFeeWei.toString(),
      base_fee_gwei: info.baseFeeWei === null ? null : weiToGwei(info.baseFeeWei),
    }))

export const getChainInfo = defineTool({
  name: 'eth_get_chain_info',
  description:
    'Identifies which network the configured RPC endpoint serves and reports the current chain head. Returns the chain id, the latest block number, and the latest block base fee in both wei and gwei (decimal strings; base fee is null on pre-EIP-1559 or non-conforming chains). Wraps eth_chainId and eth_blockNumber. Call this first whenever you are unsure which chain you are talking to or need the current head before another read.',
  input,
  output,
  idempotent: false,
  handler: chainInfoHandler,
})
