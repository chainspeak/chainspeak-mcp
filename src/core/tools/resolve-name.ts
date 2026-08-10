import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { getAddress } from 'viem'
import * as z from 'zod'
import { type ChainError, unsupported } from '../chain/errors'
import type { ChainHandle } from '../chain/registry'
import { type Address, AddressOrNameSchema, BlockRefSchema, isAddressInput } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'
import { ensHomeFor } from '../mcp/ens'

const input = z.object({
  name_or_address: AddressOrNameSchema.describe(
    'an ENS name (e.g. vitalik.eth) to resolve to an address, or a 0x address (e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045) to look up its primary ENS name — the direction is auto-detected',
  ),
  block: BlockRefSchema.default('latest').describe(
    'block on the ENS home chain to resolve at: tag (latest|safe|finalized|earliest), decimal number, or 0x-hex number; default latest. Offchain (CCIP-read) names always answer from current state',
  ),
})

const output = z.object({
  chain_id: z.string(),
  coin_type: z.string().nullable(),
  direction: z.enum(['forward', 'reverse']),
  name: z.string().nullable(),
  address: z.string().nullable(),
  forward_match: z.boolean().nullable(),
  resolved_on: z.string(),
  resolved_at_block: z.string(),
})

type Out = z.output<typeof output>

type Partial = Pick<Out, 'direction' | 'name' | 'address' | 'forward_match'>

const forward = (
  home: ChainHandle,
  name: string,
  atBlock: bigint,
  coinType: number | undefined,
): ResultAsync<Partial, ChainError> =>
  home.reader.resolveName(name, atBlock, coinType).map((res) => ({
    direction: 'forward' as const,
    name,
    address: res.address === null ? null : getAddress(res.address),
    forward_match: null,
  }))

const reverse = (
  home: ChainHandle,
  address: Address,
  atBlock: bigint,
  coinType: number | undefined,
): ResultAsync<Partial, ChainError> =>
  home.reader.reverseName(address, atBlock, coinType).andThen((name) => {
    const base = {
      direction: 'reverse' as const,
      address: getAddress(address),
    }
    if (name === null) return okAsync({ ...base, name: null, forward_match: null })
    return home.reader.resolveName(name, atBlock, coinType).map((res) => ({
      ...base,
      name,
      forward_match: res.address !== null && res.address.toLowerCase() === address.toLowerCase(),
    }))
  })

export const resolveNameHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen((target) => {
    const home = ensHomeFor(ctx, target)
    if (home === null) {
      return errAsync<Out, ChainError>(
        unsupported(
          'no configured chain has ENS',
          'configure an ethereum RPC endpoint to resolve ENS names',
        ),
      )
    }
    const coinType = target.spec.coinType ?? undefined
    return home.reader.pinBlock(args.block).andThen((pin) =>
      (isAddressInput(args.name_or_address)
        ? reverse(home, args.name_or_address, pin.number, coinType)
        : forward(home, args.name_or_address, pin.number, coinType)
      ).map((res) => ({
        chain_id: target.spec.chainId.toString(),
        coin_type: target.spec.coinType === null ? null : target.spec.coinType.toString(),
        resolved_on: home.spec.key,
        resolved_at_block: pin.number.toString(),
        ...res,
      })),
    )
  })

export const resolveName = defineTool({
  name: 'chainspeak_resolve_name',
  description:
    "Translate between ENS names and addresses in either direction, per chain: pass an ENS name (e.g. vitalik.eth) to get the address it points at, or a 0x address to get its primary ENS name — the direction is auto-detected and echoed as forward or reverse. A name can point at a DIFFERENT address on each chain (ENSIP-11 coin types), and an address can have a different primary name per chain (ENSIP-19), which is why every row reports the chain and coin_type it applies to; call with chain 'all' to see every configured chain's record at once. Records are always read on the ENS home chain (ethereum) through the ENS Universal Resolver, so offchain and L2 names such as *.base.eth resolve correctly; resolved_on and resolved_at_block echo where and when. A null address or name is a normal answer, not an error: the name is unregistered or has no record for that chain (call with chain ethereum to see whether the name has an ethereum record at all), or the address has no primary name there. For reverse lookups, forward_match reports whether the found name resolves back to the same address for that same chain — treat the name as unverified vanity data when false. If you need the balance or state of a named account, chainspeak_get_account resolves the name internally in one call; use this tool for name-only questions. ASCII names only; Unicode names must be given in normalized ASCII (punycode) form.",
  input,
  output,
  idempotent: false,
  handler: resolveNameHandler,
})
