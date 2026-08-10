import { okAsync, type ResultAsync } from 'neverthrow'
import { getAddress } from 'viem'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { scaleUnits } from '../chain/format'
import { AddressOrNameSchema, AddressSchema, BlockRefSchema } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'
import { resolveAddressInput } from '../mcp/ens'

const input = z.object({
  token: AddressSchema.describe(
    'ERC-20 contract address, e.g. 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (USDC on mainnet)',
  ),
  holder: AddressOrNameSchema.optional().describe(
    'optional: address or ENS name whose balance to read — omit it entirely when you only need token metadata',
  ),
  block: BlockRefSchema.default('latest').describe(
    'block to read at: tag (latest|safe|finalized|earliest), decimal number, or 0x-hex number, e.g. 19000000 or 0x121eac0; default latest',
  ),
})

const output = z.object({
  chain_id: z.string(),
  block_number: z.string(),
  token_address: z.string(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().nullable(),
  total_supply_raw: z.string().nullable(),
  total_supply_formatted: z.string().nullable(),
  holder: z
    .object({
      address: z.string(),
      resolved_from: z.string().nullable(),
      balance_raw: z.string(),
      balance_formatted: z.string().nullable(),
    })
    .nullable(),
})

type Out = z.output<typeof output>

export const tokenHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r }) =>
    r.chainId().andThen((chainId) =>
      r.pinBlock(args.block).andThen((pin) =>
        r.tokenInfo(args.token, pin.number).andThen((info) => {
          const base = {
            chain_id: chainId.toString(),
            block_number: pin.number.toString(),
            token_address: getAddress(args.token),
            name: info.name,
            symbol: info.symbol,
            decimals: info.decimals,
            total_supply_raw: info.totalSupply === null ? null : info.totalSupply.toString(),
            total_supply_formatted:
              info.totalSupply === null || info.decimals === null
                ? null
                : scaleUnits(info.totalSupply, info.decimals),
          }
          if (args.holder === undefined) return okAsync({ ...base, holder: null })
          return resolveAddressInput(ctx, args.chain, args.holder, pin).andThen(
            ({ address, resolved_from: resolvedFrom }) =>
              r.tokenBalance(args.token, address, pin.number).map(
                (raw): Out => ({
                  ...base,
                  holder: {
                    address: getAddress(address),
                    resolved_from: resolvedFrom,
                    balance_raw: raw.toString(),
                    balance_formatted:
                      info.decimals === null ? null : scaleUnits(raw, info.decimals),
                  },
                }),
              ),
          )
        }),
      ),
    ),
  )

export const getToken = defineTool({
  name: 'chainspeak_get_token',
  description:
    "ERC-20 token metadata, total supply, and optionally a holder's balance, in one call. Give token as the ERC-20 contract address. Metadata comes back ALWAYS — asking about a token does not require inventing a holder; add holder (address or ENS name, resolved at the same block) only when you want a balance. This is for ERC-20 tokens only — for the native ETH balance use chainspeak_get_account. Done via eth_call to the token's name, symbol, decimals, totalSupply, and (with holder) balanceOf. Returns raw smallest-unit integers as decimal strings plus decimals-adjusted formatted values (null when the token exposes no decimals); name, symbol, decimals, and total supply are null for nonstandard tokens that do not expose them — a normal answer, not an error. Every response echoes chain_id and the exact block_number it was answered at; addresses are EIP-55 checksummed. An address that is not an ERC-20 token at all returns an INVALID_INPUT error saying so.",
  input,
  output,
  idempotent: false,
  handler: tokenHandler,
})
