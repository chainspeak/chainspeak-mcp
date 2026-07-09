import type { ResultAsync } from 'neverthrow'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { EnsNameSchema } from '../chain/types'
import { defineTool, type ToolCtx } from '../mcp/define-tool'

const input = z.object({
  name: EnsNameSchema.describe(
    'ENS name to resolve, e.g. vitalik.eth — ASCII letters, digits, and hyphens only',
  ),
})

const output = z.object({
  name: z.string(),
  address: z.string().nullable(),
})

export const resolveEnsHandler = (
  args: z.output<typeof input>,
  ctx: ToolCtx,
): ResultAsync<z.output<typeof output>, ChainError> =>
  ctx
    .readerFor()
    .asyncAndThen((r) => r.resolveEns(args.name))
    .map((address) => ({ name: args.name, address }))

export const resolveEns = defineTool({
  name: 'eth_resolve_ens',
  description:
    'Forward-resolve an ENS name (e.g. vitalik.eth) to the Ethereum address it points at, via eth_call to the on-chain ENS registry and its resolver. Use this first whenever the user gives a name instead of a 0x address, then pass the address to eth_get_balance or eth_get_token_balance. address is null when the name is unregistered or has no address record — a normal answer, not an error. Reverse resolution (address to name) is not covered. ASCII names only; Unicode names are not normalized.',
  input,
  output,
  idempotent: false,
  handler: resolveEnsHandler,
})
