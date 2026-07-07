import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { invalidInputError } from '../../src/chain/errors'
import { getTokenBalance, tokenBalanceHandler } from '../../src/tools/get-token-balance'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const HOLDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const parse = (raw: Record<string, unknown>) =>
  getTokenBalance.input.parse(raw) as Parameters<typeof tokenBalanceHandler>[0]

describe('eth_get_token_balance', () => {
  it('returns raw plus decimals-adjusted formatted amount and metadata', async () => {
    const fake = createFakeReader()
    const args = parse({ token: TOKEN, holder: HOLDER })

    const result = await tokenBalanceHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      raw: '123456789',
      formatted: '123.456789',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    })
  })

  it('leaves formatted null when the token exposes no decimals', async () => {
    const fake = createFakeReader({
      tokenBalance: () =>
        okAsync({ raw: 500n, decimals: null, symbol: 'WEIRD', name: 'Weird Token' }),
    })
    const args = parse({ token: TOKEN, holder: HOLDER })

    const result = await tokenBalanceHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      raw: '500',
      formatted: null,
      symbol: 'WEIRD',
      name: 'Weird Token',
      decimals: null,
    })
  })

  it('passes through null metadata for nonstandard tokens', async () => {
    const fake = createFakeReader({
      tokenBalance: () => okAsync({ raw: 7n, decimals: 0, symbol: null, name: null }),
    })
    const args = parse({ token: TOKEN, holder: HOLDER })

    const result = await tokenBalanceHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      raw: '7',
      formatted: '7',
      symbol: null,
      name: null,
      decimals: 0,
    })
  })

  it('propagates an invalid_input reader error (e.g. token is not a contract)', async () => {
    const fake = createFakeReader({
      tokenBalance: () => errAsync(invalidInputError('token is not a contract')),
    })
    const args = parse({ token: TOKEN, holder: HOLDER })

    const result = await tokenBalanceHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().tag).toBe('invalid_input')
  })
})
