import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { upstreamTransient } from '../../src/core/chain/errors'
import type { Address } from '../../src/core/chain/types'
import { resolveName, resolveNameHandler } from '../../src/core/tools/resolve-name'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'

const parse = (raw: Record<string, unknown>) =>
  buildTool(resolveName).input.parse(raw) as Parameters<typeof resolveNameHandler>[0]

describe('chainspeak_resolve_name', () => {
  it('forward-resolves a name to an EIP-55 checksummed address', async () => {
    const fake = createFakeReader()
    const args = parse({ name_or_address: 'vitalik.eth' })

    const result = await resolveNameHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '1',
      coin_type: '60',
      resolved_on: 'ethereum',
      resolved_at_block: '19000000',
      direction: 'forward',
      name: 'vitalik.eth',
      address: VITALIK,
      forward_match: null,
    })
  })

  it('lowercases the name before resolving', async () => {
    const fake = createFakeReader()
    const args = parse({ name_or_address: 'Vitalik.ETH' })

    const result = await resolveNameHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().name).toBe('vitalik.eth')
  })

  it('answers an unregistered name with null address and has_resolver false — a normal answer', async () => {
    const fake = createFakeReader({
      resolveName: () => okAsync({ address: null, hasResolver: false }),
    })
    const args = parse({ name_or_address: 'nobody-owns-this-name-000.eth' })

    const result = await resolveNameHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.address).toBeNull()
  })

  it('reverse-resolves an address, reporting forward_match when the name points back', async () => {
    const fake = createFakeReader({
      reverseName: () => okAsync('vitalik.eth'),
      resolveName: () => okAsync({ address: VITALIK, hasResolver: true }),
    })
    const args = parse({ name_or_address: VITALIK.toLowerCase() })

    const result = await resolveNameHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '1',
      coin_type: '60',
      resolved_on: 'ethereum',
      resolved_at_block: '19000000',
      direction: 'reverse',
      name: 'vitalik.eth',
      address: VITALIK,
      forward_match: true,
    })
  })

  it('flags a reverse name that does NOT forward-resolve back', async () => {
    const OTHER = '0x28C6c06298d514Db089934071355E5743bf21d60' as Address
    const fake = createFakeReader({
      reverseName: () => okAsync('impostor.eth'),
      resolveName: () => okAsync({ address: OTHER, hasResolver: true }),
    })
    const args = parse({ name_or_address: VITALIK })

    const result = await resolveNameHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.name).toBe('impostor.eth')
    expect(out.forward_match).toBe(false)
  })

  it('answers an address without a reverse record with a null name', async () => {
    const fake = createFakeReader({ reverseName: () => okAsync(null) })
    const args = parse({ name_or_address: VITALIK })

    const result = await resolveNameHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.direction).toBe('reverse')
    expect(out.name).toBeNull()
    expect(out.address).toBe(VITALIK)
  })

  it('resolves at the pinned block, not silently at latest', async () => {
    const pinned: bigint[] = []
    const fake = createFakeReader({
      pinBlock: () => okAsync({ number: 15000000n, timestamp: 1n }),
      resolveName: (_n, atBlock) => {
        pinned.push(atBlock)
        return okAsync({ address: VITALIK, hasResolver: true })
      },
    })
    const args = parse({ name_or_address: 'vitalik.eth', block: '15000000' })

    await resolveNameHandler(args, testCtx(fake))

    expect(pinned).toEqual([15000000n])
  })

  it('rejects a bare word that is neither an address nor a dotted name', () => {
    expect(() => parse({ name_or_address: 'vitalik' })).toThrow(/0x address or a dotted ENS name/)
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      resolveName: () => errAsync(upstreamTransient('slow down', 'wait a moment', 2000)),
    })
    const args = parse({ name_or_address: 'vitalik.eth' })

    const result = await resolveNameHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_TRANSIENT')
  })
})
