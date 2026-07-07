import { okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { chainInfoHandler, getChainInfo } from '../../src/tools/get-chain-info'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

const parse = (raw: Record<string, unknown>) =>
  getChainInfo.input.parse(raw) as Parameters<typeof chainInfoHandler>[0]

describe('eth_get_chain_info', () => {
  it('converts chain info fields to decimal strings, base fee in wei and gwei', async () => {
    const fake = createFakeReader()
    const args = parse({})

    const result = await chainInfoHandler(args, testCtx(fake))

    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '1',
      latest_block: '19000000',
      base_fee_wei: '20000000000',
      base_fee_gwei: '20',
    })
  })

  it('reports null for both base fee fields when the chain has no base fee', async () => {
    const fake = createFakeReader({
      chainInfo: () => okAsync({ chainId: 5n, latestBlock: 42n, baseFeeWei: null }),
    })
    const args = parse({})

    const result = await chainInfoHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '5',
      latest_block: '42',
      base_fee_wei: null,
      base_fee_gwei: null,
    })
  })
})
