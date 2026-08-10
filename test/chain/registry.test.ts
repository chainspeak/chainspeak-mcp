import { errAsync, okAsync } from 'neverthrow'
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { internal } from '../../src/core/chain/errors'
import {
  chainKey,
  coinTypeFor,
  createChainRegistry,
  verifyChains,
} from '../../src/core/chain/registry'
import { createFakeReader } from '../fakes/chain-reader'

const entry = (chain: Parameters<typeof chainKey>[0], chainId?: bigint) => ({
  chain,
  reader: createFakeReader(chainId === undefined ? {} : { chainId: () => okAsync(chainId) }),
})

describe('chainKey', () => {
  it('derives the agent-facing key from the viem chain name', () => {
    expect(chainKey(mainnet)).toBe('ethereum')
    expect(chainKey(base)).toBe('base')
    expect(chainKey(optimism)).toBe('op-mainnet')
    expect(chainKey(arbitrum)).toBe('arbitrum-one')
  })
})

describe('coinTypeFor', () => {
  it('keeps the legacy SLIP-44 value for mainnet and derives ENSIP-11 elsewhere', () => {
    expect(coinTypeFor(1)).toBe(60)
    expect(coinTypeFor(10)).toBe(0x8000_000a)
    expect(coinTypeFor(8453)).toBe(0x8000_2105)
  })

  it('returns null for chain ids outside the 31-bit scheme', () => {
    expect(coinTypeFor(0x8000_0000)).toBeNull()
  })
})

describe('createChainRegistry', () => {
  it('derives chain metadata from viem rather than a hand-kept table', () => {
    const registry = createChainRegistry([entry(polygon, 137n)])
    const spec = registry.defaultChain.spec
    expect(spec.key).toBe('polygon')
    expect(spec.chainId).toBe(137n)
    expect(spec.native).toEqual({ symbol: 'POL', decimals: 18 })
  })

  it('derives chain features from viem contract deployments', () => {
    const registry = createChainRegistry([entry(mainnet), entry(base, 8453n)])
    const eth = registry.resolve('ethereum')._unsafeUnwrap().spec
    const b = registry.resolve('base')._unsafeUnwrap().spec
    expect(eth.features.ens).toBe(true)
    expect(eth.features.l1DataFee).toBe(false)
    expect(b.features.ens).toBe(false)
    expect(b.features.l1DataFee).toBe(true)
  })

  it('resolves by key, by chain id, and by an unambiguous short alias', () => {
    const registry = createChainRegistry([entry(mainnet), entry(optimism, 10n)])
    expect(registry.resolve('op-mainnet')._unsafeUnwrap().spec.chainId).toBe(10n)
    expect(registry.resolve('10')._unsafeUnwrap().spec.chainId).toBe(10n)
    expect(registry.resolve('op')._unsafeUnwrap().spec.chainId).toBe(10n)
    expect(registry.resolve('OP Mainnet')._unsafeUnwrap().spec.chainId).toBe(10n)
  })

  it('defaults to the first registered chain, or an explicit one', () => {
    const entries = [entry(mainnet), entry(base, 8453n)]
    expect(createChainRegistry(entries).resolve()._unsafeUnwrap().spec.key).toBe('ethereum')
    expect(
      createChainRegistry(entries, { default: 'base' }).resolve()._unsafeUnwrap().spec.key,
    ).toBe('base')
  })

  it('names every configured chain when the selector is unknown', () => {
    const registry = createChainRegistry([entry(mainnet), entry(base, 8453n)])
    const e = registry.resolve('solana')._unsafeUnwrapErr()
    expect(e.category).toBe('INVALID_INPUT')
    expect(e.hint).toContain('ethereum, base')
  })

  it('rejects an empty or duplicated registration', () => {
    expect(() => createChainRegistry([])).toThrow(/at least one chain/)
    expect(() => createChainRegistry([entry(mainnet), entry(mainnet)])).toThrow(/duplicate/)
  })
})

describe('verifyChains', () => {
  it('passes when every endpoint reports the chain it is registered as', async () => {
    const registry = createChainRegistry([entry(mainnet, 1n), entry(base, 8453n)])
    expect((await verifyChains(registry)).isOk()).toBe(true)
  })

  it('fails loudly when an endpoint serves a different chain than registered', async () => {
    const registry = createChainRegistry([entry(mainnet, 8453n)])
    const e = (await verifyChains(registry))._unsafeUnwrapErr()
    expect(e.message).toContain('registered as chain id 1')
    expect(e.message).toContain('8453')
  })

  it('surfaces an unreachable endpoint instead of silently passing', async () => {
    const registry = createChainRegistry([
      { chain: mainnet, reader: createFakeReader({ chainId: () => errAsync(internal('boom')) }) },
    ])
    expect((await verifyChains(registry)).isErr()).toBe(true)
  })
})
