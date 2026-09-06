import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { upstreamTransient } from '../../src/core/chain/errors'
import { chainStatusHandler, getChainStatus } from '../../src/core/tools/get-chain-status'
import { buildTool, createFakeReader, testCtx } from '../fakes/chain-reader'

const parse = (raw: Record<string, unknown>) =>
  buildTool(getChainStatus).input.parse(raw) as Parameters<typeof chainStatusHandler>[0]

describe('chainspeak_get_chain_status', () => {
  it('reports chain identity, head, gas tiers, and the transfer cost estimate', async () => {
    const fake = createFakeReader()
    const args = parse({})

    const result = await chainStatusHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out).toMatchObject({
      chain_id: '1',
      chain_name: 'Ethereum',
      block_number: '19000000',
      base_fee_wei: '20000000000',
      base_fee_gwei: '20',
      blob_base_fee_wei: '1',
      upstream_syncing: false,
      upstream: { trace: false, batch_cap: 3 },
      note: null,
    })
    expect(out.gas_tiers).toHaveLength(3)
    expect(out.gas_tiers?.[1]).toEqual({
      name: 'standard',
      priority_fee_wei: '1500000000',
      priority_fee_gwei: '1.5',
      total_fee_per_gas_wei: '21500000000',
      total_fee_per_gas_gwei: '21.5',
    })
    // (20 gwei base + 1.5 gwei standard tip) * 21000 gas — precomputed, no mental math
    expect(out.simple_transfer_cost).toEqual({
      gas: '21000',
      tier: 'standard',
      fee_wei: '451500000000000',
      fee_native: '0.0004515',
      l1_breakdown: null,
    })
  })

  it('answers a historical block with its base fee and current-only fields nulled', async () => {
    const fake = createFakeReader()
    const args = parse({ block: '15000000' })

    const result = await chainStatusHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.gas_tiers).toBeNull()
    expect(out.simple_transfer_cost).toBeNull()
    expect(out.note).toMatch(/historical/)
  })

  it('flags a syncing upstream node in both the flag and the note', async () => {
    const fake = createFakeReader({
      gasOutlook: () =>
        okAsync({
          baseFeeWei: 20000000000n,
          priorityTiersWei: null,
          blobBaseFeeWei: null,
          syncing: true,
        }),
    })
    const args = parse({})

    const result = await chainStatusHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.upstream_syncing).toBe(true)
    expect(out.note).toMatch(/syncing/)
  })

  it('handles a pre-EIP-1559 chain with null fee fields', async () => {
    const fake = createFakeReader({
      block: () =>
        okAsync({
          number: 1000000n,
          hash: `0x${'ab'.repeat(32)}` as const,
          parentHash: `0x${'cd'.repeat(32)}` as const,
          timestamp: 1455404053n,
          txCount: 2,
          gasUsed: 50244n,
          gasLimit: 3141592n,
          baseFeePerGasWei: null,
          txHashes: [],
          txs: null,
        }),
      gasOutlook: () =>
        okAsync({ baseFeeWei: null, priorityTiersWei: null, blobBaseFeeWei: null, syncing: false }),
    })
    const args = parse({})

    const result = await chainStatusHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.base_fee_wei).toBeNull()
    expect(out.gas_tiers).toBeNull()
    expect(out.simple_transfer_cost).toBeNull()
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      gasOutlook: () => errAsync(upstreamTransient('connection refused', 'check the endpoint')),
    })
    const args = parse({})

    const result = await chainStatusHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_TRANSIENT')
  })
})
