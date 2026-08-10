import { errAsync, okAsync } from 'neverthrow'
import { toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { upstreamPolicy } from '../../src/core/chain/errors'
import type { Address, Hash, LogFilter, RangeLog } from '../../src/core/chain/types'
import { eventsHandler, getEvents } from '../../src/core/tools/get-events'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const APPROVAL = toEventSelector('Approval(address,address,uint256)')
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const BOB = '0x28C6c06298d514Db089934071355E5743bf21d60'

const pad = (addr: string): `0x${string}` => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`
const word = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`

const parse = (raw: Record<string, unknown>) =>
  buildTool(getEvents).input.parse(raw) as Parameters<typeof eventsHandler>[0]

const transferLog = (blockNumber: bigint, logIndex: number, amount: bigint): RangeLog => ({
  address: USDC,
  topics: [TRANSFER, pad(VITALIK), pad(BOB)],
  data: word(amount),
  blockNumber,
  txHash: `0x${String(logIndex).padStart(64, '0')}` as Hash,
  logIndex,
})

const unknownLog = (blockNumber: bigint, logIndex: number): RangeLog => ({
  address: USDC,
  topics: [toEventSelector('Swap(address,uint256)'), pad(VITALIK)],
  data: word(1n),
  blockNumber,
  txHash: `0x${'ab'.repeat(32)}` as Hash,
  logIndex,
})

describe('chainspeak_get_events', () => {
  it('lists decoded transfers for an address, querying both directions', async () => {
    const filters: LogFilter[] = []
    const fake = createFakeReader({
      getLogs: (f) => {
        filters.push(f)
        return okAsync([transferLog(19000000n, 3, 1000000n)])
      },
    })
    const args = parse({ kind: 'transfers', address: VITALIK, from_block: '18999000' })

    const result = await eventsHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    // two queries: address as sender, address as receiver
    expect(filters).toHaveLength(2)
    expect(filters[0]?.topics?.[1]).toBe(pad(VITALIK))
    expect(filters[1]?.topics?.[2]).toBe(pad(VITALIK))
    // identical logs from both queries dedupe to one event
    expect(out.events).toHaveLength(1)
    expect(out.events[0]).toMatchObject({
      decoded: true,
      event: 'transfer',
      standard: 'erc20',
      from: VITALIK,
      to: BOB,
      amount_raw: '1000000',
      topics: null,
      data: null,
    })
    expect(out.resolved_address).toBe(VITALIK)
  })

  it('returns unknown events honestly undecoded with raw topics and data', async () => {
    const fake = createFakeReader({ getLogs: () => okAsync([unknownLog(19000001n, 7)]) })
    const args = parse({ kind: 'raw', emitted_by: USDC, from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.events[0]).toMatchObject({
      decoded: false,
      event: null,
      standard: null,
      emitted_by: USDC,
    })
    expect(out.events[0]?.topic0).toBeTruthy()
    expect(out.events[0]?.topics).toHaveLength(2)
    expect(out.events[0]?.data).toBe(word(1n))
  })

  it('queries approvals with both Approval signatures in one filter', async () => {
    const filters: LogFilter[] = []
    const fake = createFakeReader({
      getLogs: (f) => {
        filters.push(f)
        return okAsync([])
      },
    })
    const args = parse({ kind: 'approvals', address: VITALIK, from_block: '19000000' })

    await eventsHandler(args, testCtx(fake))

    expect(filters).toHaveLength(1)
    const topic0 = filters[0]?.topics?.[0]
    expect(Array.isArray(topic0)).toBe(true)
    expect(topic0).toContain(APPROVAL)
  })

  it('rejects a range wider than 10000 blocks with a steering hint', async () => {
    const fake = createFakeReader({
      pinBlock: (at) =>
        okAsync({ number: at === 'latest' ? 19100000n : (at as bigint), timestamp: 1n }),
    })
    const args = parse({ kind: 'transfers', address: VITALIK, from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    const e = result._unsafeUnwrapErr()
    expect(e.category).toBe('INVALID_INPUT')
    expect(e.hint).toContain('10000')
  })

  it('rejects raw kind without any filter (would scan every event on the chain)', async () => {
    const fake = createFakeReader()
    const args = parse({ kind: 'raw', from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('INVALID_INPUT')
  })

  it('rejects transfers without address AND token', async () => {
    const fake = createFakeReader()
    const args = parse({ kind: 'transfers', from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().hint).toContain('token')
  })

  it('lists ALL transfers of a token when address is omitted (one topic-filtered query)', async () => {
    const filters: LogFilter[] = []
    const fake = createFakeReader({
      getLogs: (f) => {
        filters.push(f)
        return okAsync([transferLog(19000000n, 1, 5n)])
      },
    })
    const args = parse({ kind: 'transfers', token: USDC, from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    expect(filters).toHaveLength(1)
    expect(filters[0]?.address).toBe(USDC.toLowerCase())
    expect(filters[0]?.topics).toEqual([TRANSFER])
    expect(result._unsafeUnwrap().pagination.returned).toBe(1)
  })

  it('paginates with a steering truncation message', async () => {
    const logs = Array.from({ length: 120 }, (_, i) => transferLog(19000000n + BigInt(i), i, 1n))
    const fake = createFakeReader({ getLogs: () => okAsync(logs) })
    const rawArgs = {
      kind: 'raw',
      emitted_by: USDC,
      from_block: '19000000',
      to_block: '19000200',
      limit: 50,
    }

    const result = await eventsHandler(parse(rawArgs), testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.events).toHaveLength(50)
    expect(out.pagination).toMatchObject({
      has_more: true,
      offset: 0,
      next_cursor: '50',
    })
    expect(out.pagination.message).toContain('showing events 1-50')

    const page2 = await eventsHandler(parse({ ...rawArgs, cursor: '100' }), testCtx(fake))
    expect(page2._unsafeUnwrap().events).toHaveLength(20)
    expect(page2._unsafeUnwrap().pagination.next_cursor).toBeNull()
  })

  it('sorts merged results by block then log index', async () => {
    let call = 0
    const fake = createFakeReader({
      getLogs: () => {
        call += 1
        return okAsync(
          call === 1
            ? [transferLog(19000005n, 2, 1n)]
            : [transferLog(19000001n, 9, 2n), transferLog(19000005n, 1, 3n)],
        )
      },
    })
    const args = parse({ kind: 'transfers', address: VITALIK, from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    const order = result._unsafeUnwrap().events.map((e) => `${e.block_number}:${e.log_index}`)
    expect(order).toEqual(['19000001:9', '19000005:1', '19000005:2'])
  })

  it('propagates a provider range-cap rejection unchanged (UPSTREAM_POLICY)', async () => {
    const fake = createFakeReader({
      getLogs: () =>
        errAsync(upstreamPolicy('query returned more than 10000 results', 'narrow the range')),
    })
    const args = parse({ kind: 'transfers', address: VITALIK, from_block: '19000000' })

    const result = await eventsHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_POLICY')
  })
})
