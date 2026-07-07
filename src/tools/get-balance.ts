import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { weiToDual } from '../chain/format'
import { AddressSchema, BlockRefSchema } from '../chain/types'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({
  address: AddressSchema.describe(
    '0x-prefixed 20-byte hex address, e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  ),
  block: BlockRefSchema.default('latest').describe(
    'block tag (latest|safe|finalized|earliest) or decimal block number, e.g. 19000000; default latest',
  ),
})

const output = z.object({ wei: z.string(), eth: z.string() })

export const balanceHandler = (
  args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.balance(args.address, args.block))
    .map(weiToDual)

export const getBalance = defineTool({
  name: 'eth_get_balance',
  description:
    'Native ETH balance of an address at a given block. This is the account gas-token balance only — it does NOT cover ERC-20 tokens; for a token balance use eth_get_token_balance. Wraps eth_getBalance. Returns the balance as decimal strings in both wei and ether.',
  input,
  output,
  idempotent: false,
  handler: balanceHandler,
})
