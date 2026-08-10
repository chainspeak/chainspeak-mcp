/**
 * Names are rooted on ethereum but answers are chain-specific: ENSIP-11 gives
 * each chain a coinType, and a name may point somewhere different on each. There
 * is no silent fallback to the ethereum record — the error carries that address
 * instead, so the caller chooses rather than us guessing.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { getAddress } from 'viem'
import { type ChainError, notFound, unsupported } from '../chain/errors'
import type { ChainHandle } from '../chain/registry'
import { type Address, isAddressInput, type PinnedBlock } from '../chain/types'
import type { ToolCtx } from './define-tool'

const ETHEREUM_COIN_TYPE = 60

export interface NameProvenance {
  /** the ENS name the address came from, null when an address was given */
  resolved_from: string | null
  /** which chain the ENS records were read on */
  resolved_on: string | null
  /** the block on that chain the records were read at */
  resolved_at_block: string | null
}

export interface ResolvedInput extends NameProvenance {
  address: Address
}

export const NO_PROVENANCE: NameProvenance = {
  resolved_from: null,
  resolved_on: null,
  resolved_at_block: null,
}

export const ensHomeFor = (ctx: ToolCtx, target: ChainHandle): ChainHandle | null =>
  target.spec.features.ens ? target : (ctx.chains.find((c) => c.spec.features.ens) ?? null)

/**
 * Where ENS is read for a target chain, and at which block. On the ENS home
 * chain itself the caller's own pinned block is used, which keeps the existing
 * "resolved at the same block as the state read" guarantee. Off it, records are
 * read at the home chain's head — CCIP-read gateways serve current state only,
 * so historical resolution is not available for offchain names either way.
 */
const ensPin = (
  home: ChainHandle,
  target: ChainHandle,
  targetPin: PinnedBlock,
): ResultAsync<PinnedBlock, ChainError> =>
  home.spec.key === target.spec.key ? okAsync(targetPin) : home.reader.pinBlock('latest')

const noEnsConfigured = (name: string): ChainError =>
  unsupported(
    `cannot resolve '${name}': no configured chain has ENS`,
    'configure an ethereum RPC endpoint to resolve ENS names, or pass a 0x address instead',
  )

/**
 * Turn an address-or-name input into an address for `target`, resolving names
 * on the ENS home chain with the target chain's coinType.
 */
export const resolveAddressInput = (
  ctx: ToolCtx,
  chain: string | undefined,
  input: string,
  targetPin: PinnedBlock,
): ResultAsync<ResolvedInput, ChainError> => {
  if (isAddressInput(input)) return okAsync({ address: input, ...NO_PROVENANCE })
  return ctx.resolve(chain).asyncAndThen((target) => forName(ctx, target, input, targetPin))
}

const forName = (
  ctx: ToolCtx,
  target: ChainHandle,
  input: string,
  targetPin: PinnedBlock,
): ResultAsync<ResolvedInput, ChainError> => {
  const home = ensHomeFor(ctx, target)
  if (home === null) return errAsync(noEnsConfigured(input))

  return ensPin(home, target, targetPin).andThen((pin) =>
    home.reader.resolveName(input, pin.number, target.spec.coinType ?? undefined).andThen((res) =>
      res.address !== null
        ? okAsync<ResolvedInput, ChainError>({
            address: res.address,
            resolved_from: input,
            resolved_on: home.spec.key,
            resolved_at_block: pin.number.toString(),
          })
        : missingRecord(home, target, input, pin),
    ),
  )
}

/**
 * No record for the target chain. Before failing, look up the ethereum record so
 * the error can hand the model an address to retry with — addresses are portable
 * across EVM chains, so that is almost always what the user meant.
 */
const missingRecord = (
  home: ChainHandle,
  target: ChainHandle,
  name: string,
  pin: PinnedBlock,
): ResultAsync<ResolvedInput, ChainError> => {
  const onHomeChain = target.spec.coinType === ETHEREUM_COIN_TYPE
  if (onHomeChain) return errAsync(unresolvable(name, target, pin))

  return home.reader
    .resolveName(name, pin.number, ETHEREUM_COIN_TYPE)
    .orElse(() => okAsync({ address: null }))
    .andThen((eth) =>
      errAsync<ResolvedInput, ChainError>(
        eth.address === null
          ? unresolvable(name, target, pin)
          : notFound(
              `'${name}' has no address record for ${target.spec.key} (coinType ${target.spec.coinType}); its ethereum record is ${getAddress(eth.address)}`,
              `addresses are portable across EVM chains — to read that same account on ${target.spec.key}, call this tool again with address ${getAddress(eth.address)} and chain ${target.spec.key}, or use chainspeak_resolve_name to see every chain's record`,
            ),
      ),
    )
}

const unresolvable = (name: string, target: ChainHandle, pin: PinnedBlock): ChainError =>
  notFound(
    `ENS name '${name}' does not resolve to an address for ${target.spec.key} at block ${pin.number}, and has no ethereum record either`,
    'the name is most likely unregistered, expired, or misspelled — check the spelling, or call chainspeak_resolve_name with chain all to see every chain record',
  )

/**
 * The ENSIP-19 primary name for an address on the target chain, reported only
 * when it forward-resolves back to the same address for that same chain.
 */
export const verifiedPrimaryName = (
  ctx: ToolCtx,
  chain: string | undefined,
  address: Address,
  targetPin: PinnedBlock,
): ResultAsync<string | null, ChainError> =>
  ctx.resolve(chain).asyncAndThen((target) => primaryName(ctx, target, address, targetPin))

const primaryName = (
  ctx: ToolCtx,
  target: ChainHandle,
  address: Address,
  targetPin: PinnedBlock,
): ResultAsync<string | null, ChainError> => {
  const home = ensHomeFor(ctx, target)
  if (home === null) return okAsync(null)
  const coinType = target.spec.coinType ?? undefined

  return ensPin(home, target, targetPin)
    .andThen((pin) =>
      home.reader
        .reverseName(address, pin.number, coinType)
        .andThen((name) =>
          name === null
            ? okAsync(null)
            : home.reader
                .resolveName(name, pin.number, coinType)
                .map((res) =>
                  res.address !== null && res.address.toLowerCase() === address.toLowerCase()
                    ? name
                    : null,
                ),
        ),
    )
    .orElse(() => okAsync(null))
}
