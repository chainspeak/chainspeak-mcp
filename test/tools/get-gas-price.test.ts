import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { transportError } from '../../src/chain/errors'
import { gasPriceHandler } from '../../src/tools/get-gas-price'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

describe('eth_get_gas_price', () => {
  it('returns base, priority, and total per-gas prices in wei and gwei', async () => {
    const fake = createFakeReader()

    const result = await gasPriceHandler({}, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      base_fee_wei: '20000000000',
      base_fee_gwei: '20',
      priority_fee_wei: '1500000000',
      priority_fee_gwei: '1.5',
      total_fee_wei: '21500000000',
      total_fee_gwei: '21.5',
    })
  })

  it('leaves base-fee-derived fields null on a pre-EIP-1559 chain', async () => {
    const fake = createFakeReader({
      feeEstimate: () => okAsync({ baseFeeWei: null, maxPriorityFeeWei: 1000000000n }),
    })

    const result = await gasPriceHandler({}, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      base_fee_wei: null,
      base_fee_gwei: null,
      priority_fee_wei: '1000000000',
      priority_fee_gwei: '1',
      total_fee_wei: null,
      total_fee_gwei: null,
    })
  })

  it('propagates a transport error from the reader', async () => {
    const fake = createFakeReader({
      feeEstimate: () => errAsync(transportError('connection refused')),
    })

    const result = await gasPriceHandler({}, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().tag).toBe('transport')
  })
})
