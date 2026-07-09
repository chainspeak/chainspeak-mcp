import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { scaleUnits } from '../chain/format'
import { AddressSchema } from '../chain/types'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({
  token: AddressSchema.describe(
    'ERC-20 contract address, e.g. 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (USDC)',
  ),
  holder: AddressSchema.describe(
    'address whose balance to read, e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  ),
})

const output = z.object({
  raw: z.string(),
  formatted: z.string().nullable(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().nullable(),
})

export const tokenBalanceHandler = (
  args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.tokenBalance(args.token, args.holder))
    .map((balance) => ({
      raw: balance.raw.toString(),
      formatted: balance.decimals === null ? null : scaleUnits(balance.raw, balance.decimals),
      symbol: balance.symbol,
      name: balance.name,
      decimals: balance.decimals,
    }))

export const getTokenBalance = defineTool({
  name: 'eth_get_token_balance',
  description:
    "ERC-20 token balance of a holder for a given token contract. This is for ERC-20 tokens only — for the native ETH balance use eth_get_balance. Done via eth_call to the token's balanceOf, decimals, symbol, and name functions. Returns raw (smallest-unit integer as a decimal string) plus formatted (the decimals-adjusted human amount, null when the token exposes no decimals) and best-effort metadata; symbol, name, and decimals are null for nonstandard tokens that do not expose them. For ENS names like vitalik.eth, resolve to an address first with eth_resolve_ens.",
  input,
  output,
  idempotent: false,
  handler: tokenBalanceHandler,
})
