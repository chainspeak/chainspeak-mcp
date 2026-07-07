import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { rateLimitedError } from '../../src/chain/errors'
import { balanceHandler, getBalance } from '../../src/tools/get-balance'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const parse = (raw: Record<string, unknown>) =>
  getBalance.input.parse(raw) as Parameters<typeof balanceHandler>[0]

describe('eth_get_balance', () => {
  it('returns the balance as dual wei + eth decimal strings', async () => {
    const fake = createFakeReader()
    const args = parse({ address: ADDR })

    const result = await balanceHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({ wei: '1500000000000000000', eth: '1.5' })
  })

  it('defaults block to latest when omitted', () => {
    const args = parse({ address: ADDR })
    expect(args.block).toBe('latest')
  })

  it('accepts a decimal block number and normalizes the address to lowercase', () => {
    const args = parse({ address: ADDR, block: '19000000' })
    expect(args.block).toBe(19000000n)
    expect(args.address).toBe(ADDR.toLowerCase())
  })

  it('rejects a malformed address with a corrective message showing a valid example', () => {
    const parsed = getBalance.input.safeParse({ address: 'nope' })
    expect(parsed.success).toBe(false)
    const message = parsed.error?.issues[0]?.message ?? ''
    expect(message).toMatch(/0x/)
    expect(message).toMatch(/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/)
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      balance: () => errAsync(rateLimitedError('slow down', 1000)),
    })
    const args = parse({ address: ADDR })

    const result = await balanceHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().tag).toBe('rate_limited')
  })

  it('reads at a specific block from the reader', async () => {
    const fake = createFakeReader({ balance: () => okAsync(1n) })
    const args = parse({ address: ADDR, block: 'safe' })

    const result = await balanceHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().wei).toBe('1')
  })
})
