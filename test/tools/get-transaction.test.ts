import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { transportError } from '../../src/chain/errors'
import type { Address } from '../../src/chain/types'
import { getTransaction, transactionHandler } from '../../src/tools/get-transaction'
import { createFakeReader, testCtx } from '../fakes/chain-reader'

const HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060'

const parse = (raw: Record<string, unknown>) =>
  getTransaction.input.parse(raw) as Parameters<typeof transactionHandler>[0]

describe('eth_get_transaction', () => {
  it('summarizes a successful transaction with dual-unit value, prices, and fee', async () => {
    const fake = createFakeReader()
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      found: true,
      status: 'success',
      from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      to: '0x28c6c06298d514db089934071355e5743bf21d60',
      value_wei: '1500000000000000000',
      value_eth: '1.5',
      block_number: '19000000',
      gas_used: '21000',
      effective_gas_price_wei: '20000000000',
      effective_gas_price_gwei: '20',
      fee_paid_wei: '420000000000000',
      fee_paid_eth: '0.00042',
      log_count: 0,
      note: null,
    })
  })

  it('reports a reverted transaction as failed', async () => {
    const fake = createFakeReader({
      transaction: () =>
        okAsync({
          status: 'failed' as const,
          from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as Address,
          to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address,
          valueWei: 0n,
          blockNumber: 19000001n,
          gasUsed: 34000n,
          effectiveGasPriceWei: 25000000000n,
          logCount: 0,
        }),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    const value = result._unsafeUnwrap()
    expect(value.found).toBe(true)
    expect(value.status).toBe('failed')
    expect(value.fee_paid_wei).toBe('850000000000000')
  })

  it('leaves receipt fields null for a pending transaction', async () => {
    const fake = createFakeReader({
      transaction: () =>
        okAsync({
          status: 'pending' as const,
          from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as Address,
          to: '0x28c6c06298d514db089934071355e5743bf21d60' as Address,
          valueWei: 1000000000000000000n,
          blockNumber: null,
          gasUsed: null,
          effectiveGasPriceWei: null,
          logCount: null,
        }),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      found: true,
      status: 'pending',
      from: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
      to: '0x28c6c06298d514db089934071355e5743bf21d60',
      value_wei: '1000000000000000000',
      value_eth: '1',
      block_number: null,
      gas_used: null,
      effective_gas_price_wei: null,
      effective_gas_price_gwei: null,
      fee_paid_wei: null,
      fee_paid_eth: null,
      log_count: null,
      note: null,
    })
  })

  it('answers an unknown hash with found false and an explanatory note', async () => {
    const fake = createFakeReader({ transaction: () => okAsync(null) })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    const value = result._unsafeUnwrap()
    expect(value.found).toBe(false)
    expect(value.status).toBeNull()
    expect(value.note).toMatch(/not found/)
  })

  it('propagates a transport error from the reader', async () => {
    const fake = createFakeReader({
      transaction: () => errAsync(transportError('connection refused')),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().tag).toBe('transport')
  })
})
