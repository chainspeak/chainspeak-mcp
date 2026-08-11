import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { invalidInput, upstreamTransient } from '../../src/core/chain/errors'
import type { Address, TokenInfo } from '../../src/core/chain/types'
import { getToken, tokenHandler } from '../../src/core/tools/get-token'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'
import { TOKENS } from '../fixtures/mainnet'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const parse = (raw: Record<string, unknown>) =>
  buildTool(getToken).input.parse(raw) as Parameters<typeof tokenHandler>[0]

describe('chainspeak_get_token', () => {
  it('returns metadata WITHOUT any holder — no invented holder needed', async () => {
    const fake = createFakeReader()
    const args = parse({ token: USDC })

    const result = await tokenHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '1',
      block_number: '19000000',
      token_address: USDC,
      standard: 'erc20',
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      total_supply_raw: '1000000000000000',
      total_supply_formatted: '1000000000',
      holder: null,
    })
  })

  it('rejects a non-address token input with a corrective message', () => {
    const parsed = buildTool(getToken).input.safeParse({ token: 'USDC' })
    expect(parsed.success).toBe(false)
    const message = parsed.error?.issues[0]?.message ?? ''
    expect(message).toMatch(/42-character/)
  })

  it('adds the balance when a holder is given', async () => {
    const fake = createFakeReader()
    const args = parse({ token: USDC, holder: VITALIK })

    const result = await tokenHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().holder).toEqual({
      address: VITALIK,
      resolved_from: null,
      balance_raw: '123456789',
      balance_formatted: '123.456789',
    })
  })

  it('resolves an ENS holder at the same pinned block as the balance read', async () => {
    const blocks: bigint[] = []
    const fake = createFakeReader({
      resolveName: (_n, atBlock) => {
        blocks.push(atBlock)
        return okAsync({ address: VITALIK, hasResolver: true })
      },
      tokenBalance: (_t, _h, atBlock) => {
        blocks.push(atBlock)
        return okAsync(1n)
      },
    })
    const args = parse({ token: USDC, holder: 'vitalik.eth', block: '19000000' })

    const result = await tokenHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().holder?.resolved_from).toBe('vitalik.eth')
    expect(blocks).toEqual([19000000n, 19000000n])
  })

  it('reads at a historical block (the block param exists now)', async () => {
    const blocks: bigint[] = []
    const fake = createFakeReader({
      pinBlock: () => okAsync({ number: 15000000n, timestamp: 1n }),
      tokenInfo: (_t, atBlock) => {
        blocks.push(atBlock)
        return okAsync({ name: null, symbol: 'USDC', decimals: 6, totalSupply: null })
      },
    })
    const args = parse({ token: USDC, block: '15000000' })

    const result = await tokenHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().block_number).toBe('15000000')
    expect(blocks).toEqual([15000000n])
  })

  it('formats nothing when the token exposes no decimals', async () => {
    const fake = createFakeReader({
      tokenInfo: () => okAsync({ name: 'Weird', symbol: 'WRD', decimals: null, totalSupply: 42n }),
    })
    const args = parse({ token: USDC, holder: VITALIK })

    const result = await tokenHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.total_supply_formatted).toBeNull()
    expect(out.holder?.balance_formatted).toBeNull()
    expect(out.holder?.balance_raw).toBe('123456789')
  })

  it('propagates a not-a-token diagnosis unchanged', async () => {
    const fake = createFakeReader({
      tokenInfo: () =>
        errAsync(invalidInput('not a token', 'verify the address is an ERC-20 contract')),
    })
    const args = parse({ token: USDC })

    const result = await tokenHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('INVALID_INPUT')
  })
})

describe('token standard detection', () => {
  const asToken = (address: string) => address as Address
  const OPENSEA = TOKENS.erc1155.value

  const probing = (answers: Record<string, boolean>, info?: Partial<TokenInfo>) =>
    createFakeReader({
      supportsInterface: (_a, id) => okAsync(answers[id] ?? false),
      tokenInfo: () =>
        okAsync({
          name: 'USD Coin',
          symbol: 'USDC',
          decimals: 6,
          totalSupply: 1000000000000000n,
          ...info,
        }),
    })

  it('reports erc20 when ERC-165 denies both NFT interfaces and decimals exist', async () => {
    const out = (await tokenHandler(parse({ token: USDC }), testCtx(probing({}))))._unsafeUnwrap()
    expect(out.standard).toBe('erc20')
  })

  it('reports erc1155 for the pinned OpenSea Shared Storefront shape', async () => {
    const fake = probing(
      { '0xd9b67a26': true },
      { name: 'OpenSea Shared Storefront', symbol: 'OPENSTORE', decimals: null, totalSupply: null },
    )
    const out = (
      await tokenHandler(parse({ token: asToken(OPENSEA) }), testCtx(fake))
    )._unsafeUnwrap()

    expect(out.standard).toBe('erc1155')
    // the shape that previously made an ERC-1155 indistinguishable from a broken ERC-20
    expect(out.decimals).toBeNull()
    expect(out.total_supply_raw).toBeNull()
    expect(out.name).toBe(TOKENS.erc1155.expect.name)
  })

  it('reports erc721 ahead of the decimals tiebreak', async () => {
    const fake = probing({ '0x80ac58cd': true }, { decimals: null, totalSupply: 10000n })
    const out = (await tokenHandler(parse({ token: USDC }), testCtx(fake)))._unsafeUnwrap()
    expect(out.standard).toBe('erc721')
  })

  it('answers null rather than guessing when the probe itself fails', async () => {
    const fake = createFakeReader({
      supportsInterface: () => errAsync(upstreamTransient('node busy', 'retry')),
    })
    const out = (await tokenHandler(parse({ token: USDC }), testCtx(fake)))._unsafeUnwrap()
    // decimals exist, but an unchecked guess could relabel an NFT as fungible
    expect(out.standard).toBeNull()
  })

  it('refuses a holder balance on erc1155 instead of returning a meaningless number', async () => {
    const fake = probing({ '0xd9b67a26': true }, { decimals: null })
    const e = (
      await tokenHandler(parse({ token: asToken(OPENSEA), holder: VITALIK }), testCtx(fake))
    )._unsafeUnwrapErr()

    expect(e.category).toBe('INVALID_INPUT')
    expect(e.message).toContain('per token id')
    expect(e.hint).toContain('omit holder')
  })
})
