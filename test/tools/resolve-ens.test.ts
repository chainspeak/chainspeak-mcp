import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { rateLimitedError } from '../../src/chain/errors'
import { resolveEns, resolveEnsHandler } from '../../src/tools/resolve-ens'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

const parse = (raw: Record<string, unknown>) =>
  resolveEns.input.parse(raw) as Parameters<typeof resolveEnsHandler>[0]

describe('eth_resolve_ens', () => {
  it('resolves a name to its address', async () => {
    const fake = createFakeReader()
    const args = parse({ name: 'vitalik.eth' })

    const result = await resolveEnsHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      name: 'vitalik.eth',
      address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    })
  })

  it('lowercases the name before resolving', async () => {
    const fake = createFakeReader()
    const args = parse({ name: 'Vitalik.ETH' })

    const result = await resolveEnsHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().name).toBe('vitalik.eth')
  })

  it('answers an unregistered name with a null address', async () => {
    const fake = createFakeReader({ resolveEns: () => okAsync(null) })
    const args = parse({ name: 'nobody-owns-this-name-000.eth' })

    const result = await resolveEnsHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      name: 'nobody-owns-this-name-000.eth',
      address: null,
    })
  })

  it('rejects a name without a dot', () => {
    expect(() => parse({ name: 'vitalik' })).toThrow(/dotted ENS name/)
  })

  it('propagates a rate-limit error from the reader', async () => {
    const fake = createFakeReader({
      resolveEns: () => errAsync(rateLimitedError('slow down', 2000)),
    })
    const args = parse({ name: 'vitalik.eth' })

    const result = await resolveEnsHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().tag).toBe('rate_limited')
  })
})
