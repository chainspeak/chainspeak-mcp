import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { upstreamTransient } from '../../src/core/chain/errors'
import type { Address, BlockData, Hash } from '../../src/core/chain/types'
import { blockHandler, getBlock } from '../../src/core/tools/get-block'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'

const HASH = '0xb5a7bcbeb1a9d1a2b0b4b6de3d4a3f6b9a0c1d2e3f405162738495a6b7c8d9e0'

const parse = (raw: Record<string, unknown>) =>
  buildTool(getBlock).input.parse(raw) as Parameters<typeof blockHandler>[0]

const manyTxs = (n: number): BlockData => ({
  number: 19000000n,
  hash: HASH as Hash,
  parentHash: HASH as Hash,
  timestamp: 1705000000n,
  txCount: n,
  gasUsed: 15000000n,
  gasLimit: 30000000n,
  baseFeePerGasWei: 20000000000n,
  txHashes: Array.from({ length: n }, (_, i) => `0x${String(i).padStart(64, '0')}` as Hash),
  txs: Array.from({ length: n }, (_, i) => ({
    hash: `0x${String(i).padStart(64, '0')}` as Hash,
    from: VITALIK,
    to: '0x28C6c06298d514Db089934071355E5743bf21d60' as Address,
    valueWei: BigInt(i),
    nonce: i,
    txType: 'eip1559',
  })),
})

describe('chainspeak_get_block', () => {
  it('summarizes a block with timestamps in both forms and gas fullness', async () => {
    const fake = createFakeReader()
    const args = parse({})

    const result = await blockHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toMatchObject({
      chain_id: '1',
      block_number: '19000000',
      found: true,
      hash: HASH,
      timestamp_unix: '1705000000',
      timestamp_iso: '2024-01-11T19:06:40.000Z',
      tx_count: 2,
      gas_used: '15000000',
      gas_limit: '30000000',
      gas_used_percent: '50.00',
      base_fee_gwei: '20',
      tx_hashes: null,
      transactions: null,
      pagination: null,
    })
  })

  it('parses block hashes, hex numbers, and tags as distinct inputs', () => {
    expect(parse({ block: `0x${'ab'.repeat(32)}` }).block).toEqual({
      hash: `0x${'ab'.repeat(32)}`,
    })
    expect(parse({ block: '0x121eac0' }).block).toBe(19000000n)
    expect(parse({ block: '19000000' }).block).toBe(19000000n)
    expect(parse({ block: 'finalized' }).block).toBe('finalized')
  })

  it('lists tx hashes with pagination and a steering truncation message', async () => {
    const fake = createFakeReader({ block: () => okAsync(manyTxs(340)) })
    const args = parse({ detail: 'tx_hashes', limit: 20 })

    const result = await blockHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.tx_hashes).toHaveLength(20)
    expect(out.pagination).toMatchObject({
      total: 340,
      offset: 0,
      limit: 20,
      next_cursor: '20',
    })
    expect(out.pagination?.message).toContain('showing tx hashes 1-20 of 340')
    expect(out.pagination?.message).toContain('cursor')
  })

  it('continues from a cursor and goes silent when the list is complete', async () => {
    const fake = createFakeReader({ block: () => okAsync(manyTxs(30)) })
    const args = parse({ detail: 'tx_hashes', limit: 20, cursor: '20' })

    const result = await blockHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.tx_hashes).toHaveLength(10)
    expect(out.pagination?.next_cursor).toBeNull()
    expect(out.pagination?.message).toBeNull()
  })

  it('returns full transactions with value in both units at detail full_txs', async () => {
    const fake = createFakeReader({ block: () => okAsync(manyTxs(3)) })
    const args = parse({ detail: 'full_txs' })

    const result = await blockHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.transactions).toHaveLength(3)
    expect(out.transactions?.[1]).toMatchObject({
      from: VITALIK,
      value_wei: '1',
      nonce: 1,
      tx_type: 'eip1559',
    })
  })

  it('answers an unknown block with found false and the current head as context', async () => {
    const fake = createFakeReader({ block: () => okAsync(null) })
    const args = parse({ block: '99999999999' })

    const result = await blockHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.found).toBe(false)
    expect(out.note).toMatch(/not found/)
    expect(out.block_number).toBe('19000000')
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      block: () => errAsync(upstreamTransient('connection refused', 'check the endpoint')),
    })
    const args = parse({})

    const result = await blockHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_TRANSIENT')
  })
})
