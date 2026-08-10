import type { ResultAsync } from 'neverthrow'
import { getAddress } from 'viem'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { weiToDual } from '../chain/format'
import { AddressOrNameSchema, BlockRefSchema } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'
import { resolveAddressInput, verifiedPrimaryName } from '../mcp/ens'

const input = z.object({
  address_or_name: AddressOrNameSchema.describe(
    '0x address (e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045) or ENS name (e.g. vitalik.eth) — names are resolved internally at the same block as the state read',
  ),
  block: BlockRefSchema.default('latest').describe(
    'block to read at: tag (latest|safe|finalized|earliest), decimal number, or 0x-hex number, e.g. 19000000 or 0x121eac0; default latest',
  ),
})

const output = z.object({
  chain_id: z.string(),
  block_number: z.string(),
  address: z.string(),
  resolution: z.object({ name: z.string(), chain: z.string(), block: z.string() }).nullable(),
  balance_wei: z.string(),
  balance_native: z.string(),
  native_symbol: z.string(),
  nonce: z.number(),
  is_contract: z.boolean(),
  delegated_to: z.string().nullable(),
  ens_name: z.string().nullable(),
})

type Out = z.output<typeof output>

export const accountHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r, spec }) =>
    r.chainId().andThen((chainId) =>
      r.pinBlock(args.block).andThen((pin) =>
        resolveAddressInput(ctx, args.chain, args.address_or_name, pin).andThen((resolved) =>
          r.account(resolved.address, pin.number).andThen((state) =>
            verifiedPrimaryName(ctx, args.chain, resolved.address, pin).map((ensName): Out => {
              const balance = weiToDual(state.balanceWei, spec.native.decimals)
              return {
                chain_id: chainId.toString(),
                block_number: pin.number.toString(),
                address: getAddress(resolved.address),
                resolution:
                  resolved.resolved_from === null
                    ? null
                    : {
                        name: resolved.resolved_from,
                        chain: resolved.resolved_on ?? '',
                        block: resolved.resolved_at_block ?? '',
                      },
                balance_wei: balance.wei,
                balance_native: balance.native,
                native_symbol: spec.native.symbol,
                nonce: state.nonce,
                is_contract: state.isContract,
                delegated_to: state.delegatedTo,
                ens_name: ensName,
              }
            }),
          ),
        ),
      ),
    ),
  )

export const getAccount = defineTool({
  name: 'chainspeak_get_account',
  description:
    'Full state of an Ethereum account at a given block: native ETH balance as decimal strings in both wei and ether, transaction count (nonce), whether the address is a contract, and its reverse ENS name when one is set and verified. Accepts a 0x address or an ENS name directly on ANY chain — names are resolved on the ENS home chain (ethereum) using the ENSIP-11 coinType of the target chain, so a name works on any chain in one call WHEN it has a record for that chain. Most names only have an ethereum record: asking about such a name on another chain returns NOT_FOUND carrying the ethereum address, and calling again with that 0x address is the intended next step (addresses are portable across EVM chains). resolution echoes the name, and which chain and block it was read on (null when a 0x address was given). This is the native gas-token balance only — it does NOT cover ERC-20 tokens; for a token balance use chainspeak_get_token. Wraps eth_getBalance, eth_getTransactionCount, and eth_getCode. Every response echoes chain_id and the exact block_number it was answered at; address is always EIP-55 checksummed. ens_name is the reverse ENS record of the address, forward-verified, and null when unset — a normal answer, not an error. An EIP-7702-delegated EOA reports is_contract false with the delegate in delegated_to (null when not delegated). An unresolvable name returns a NOT_FOUND error; inspect the name itself with chainspeak_resolve_name.',
  input,
  output,
  idempotent: false,
  handler: accountHandler,
})
