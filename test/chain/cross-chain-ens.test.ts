import { okAsync } from 'neverthrow'
import { base, mainnet, polygon } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { createChainRegistry } from '../../src/core/chain/registry'
import type { Address } from '../../src/core/chain/types'
import type { ToolCtx } from '../../src/core/mcp/define-tool'
import { accountHandler } from '../../src/core/tools/get-account'
import { createFakeReader, silentLogger, VITALIK } from '../fakes/chain-reader'

const BASE_ADDRESS = '0x1111111111111111111111111111111111111111' as Address
const ETH_COIN_TYPE = 60
const BASE_COIN_TYPE = 0x8000_2105

/** ENS answers per coinType, the way a real name with an L2 record behaves. */
const ensReader = (records: Record<number, Address | null>, primary?: string) =>
  createFakeReader({
    chainId: () => okAsync(1n),
    resolveName: vi.fn((_name: string, _at: bigint, coinType?: number) =>
      okAsync({ address: records[coinType ?? ETH_COIN_TYPE] ?? null, hasResolver: true }),
    ),
    reverseName: vi.fn(() => okAsync(primary ?? null)),
  })

const ctxFor = (
  chain: 'ethereum' | 'base',
  ens = ensReader({ [ETH_COIN_TYPE]: VITALIK }),
): {
  ctx: ToolCtx
  chain: string
  ens: ReturnType<typeof ensReader>
} => {
  const registry = createChainRegistry([
    { chain: mainnet, reader: ens },
    { chain: base, reader: createFakeReader({ chainId: () => okAsync(8453n) }) },
  ])
  return {
    ctx: { resolve: registry.resolve, chains: registry.chains, log: silentLogger },
    chain,
    ens,
  }
}

describe('cross-chain ENS', () => {
  it('resolves a name for a non-ENS chain using that chain coinType, on the ENS home chain', async () => {
    const ens = ensReader({ [ETH_COIN_TYPE]: VITALIK, [BASE_COIN_TYPE]: BASE_ADDRESS })
    const { ctx, chain } = ctxFor('base', ens)

    const out = (
      await accountHandler({ address_or_name: 'vitalik.eth', block: 'latest', chain }, ctx)
    )._unsafeUnwrap()

    expect(out.address).toBe(BASE_ADDRESS)
    expect(out.resolution?.chain).toBe('ethereum')
    expect(out.resolution?.block).toBe('19000000')
    expect(ens.resolveName).toHaveBeenCalledWith('vitalik.eth', 19000000n, BASE_COIN_TYPE)
  })

  it('never falls back to the ethereum record, and hands the address to the model instead', async () => {
    const ens = ensReader({ [ETH_COIN_TYPE]: VITALIK })
    const { ctx, chain } = ctxFor('base', ens)

    const e = (
      await accountHandler({ address_or_name: 'vitalik.eth', block: 'latest', chain }, ctx)
    )._unsafeUnwrapErr()

    expect(e.category).toBe('NOT_FOUND')
    expect(e.message).toContain('no address record for base')
    expect(e.message).toContain(VITALIK)
    expect(e.hint).toContain(VITALIK)
    expect(e.hint).toContain('chain base')
  })

  it('keeps same-block resolution when the target chain IS the ENS home', async () => {
    const ens = ensReader({ [ETH_COIN_TYPE]: VITALIK })
    const { ctx, chain } = ctxFor('ethereum', ens)

    const out = (
      await accountHandler({ address_or_name: 'vitalik.eth', block: 'latest', chain }, ctx)
    )._unsafeUnwrap()

    expect(out.address).toBe(VITALIK)
    expect(ens.resolveName).toHaveBeenCalledWith('vitalik.eth', 19000000n, ETH_COIN_TYPE)
  })

  it('reports an ENSIP-19 primary name for an address on a non-ENS chain', async () => {
    const ens = ensReader({ [BASE_COIN_TYPE]: VITALIK }, 'vitalik.base.eth')
    const { ctx, chain } = ctxFor('base', ens)

    const out = (
      await accountHandler({ address_or_name: VITALIK, block: 'latest', chain }, ctx)
    )._unsafeUnwrap()

    expect(out.ens_name).toBe('vitalik.base.eth')
    expect(ens.reverseName).toHaveBeenCalledWith(VITALIK, 19000000n, BASE_COIN_TYPE)
  })

  it('explains itself when no configured chain has ENS', async () => {
    const registry = createChainRegistry([
      { chain: polygon, reader: createFakeReader({ chainId: () => okAsync(137n) }) },
    ])
    const ctx: ToolCtx = {
      resolve: registry.resolve,
      chains: registry.chains,
      log: silentLogger,
    }

    const e = (
      await accountHandler(
        { address_or_name: 'vitalik.eth', block: 'latest', chain: 'polygon' },
        ctx,
      )
    )._unsafeUnwrapErr()

    expect(e.category).toBe('UNSUPPORTED')
    expect(e.hint).toContain('ethereum RPC')
  })
})
