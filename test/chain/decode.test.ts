import { toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { decodeMethod, decodeTokenEvents, describeRevertData } from '../../src/core/chain/decode'
import type { Address, LogEntry } from '../../src/core/chain/types'

const TRANSFER = toEventSelector('Transfer(address,address,uint256)')
const APPROVAL = toEventSelector('Approval(address,address,uint256)')
const APPROVAL_FOR_ALL = toEventSelector('ApprovalForAll(address,address,bool)')

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const ALICE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const BOB = '0x28C6c06298d514Db089934071355E5743bf21d60'

const pad = (addr: string): `0x${string}` => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`
const word = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`

const log = (topics: `0x${string}`[], data: `0x${string}`, logIndex = 0): LogEntry => ({
  address: TOKEN,
  topics,
  data,
  logIndex,
})

describe('decodeMethod', () => {
  it('recognizes a bundled selector and names it', () => {
    expect(decodeMethod(`0xa9059cbb${'0'.repeat(128)}`)).toEqual({
      selector: '0xa9059cbb',
      name: 'transfer',
    })
  })

  it('returns the selector with a null name outside the bundled set', () => {
    expect(decodeMethod(`0xdeadbeef${'0'.repeat(64)}`)).toEqual({
      selector: '0xdeadbeef',
      name: null,
    })
  })

  it('returns null for a plain value transfer (empty calldata)', () => {
    expect(decodeMethod('0x')).toBeNull()
  })
})

describe('decodeTokenEvents', () => {
  it('decodes an ERC-20 Transfer (amount in data, 3 topics)', () => {
    const events = decodeTokenEvents([log([TRANSFER, pad(ALICE), pad(BOB)], word(1000000n), 7)])
    expect(events).toEqual([
      {
        standard: 'erc20',
        event: 'transfer',
        token: TOKEN,
        from: ALICE,
        to: BOB,
        amount_raw: '1000000',
        token_id: null,
        approved: null,
        log_index: 7,
      },
    ])
  })

  it('decodes an ERC-721 Transfer (token id indexed, 4 topics)', () => {
    const events = decodeTokenEvents([log([TRANSFER, pad(ALICE), pad(BOB), word(42n)], '0x')])
    expect(events[0]).toMatchObject({
      standard: 'erc721',
      event: 'transfer',
      token_id: '42',
      amount_raw: null,
    })
  })

  it('decodes an ERC-20 Approval', () => {
    const events = decodeTokenEvents([log([APPROVAL, pad(ALICE), pad(BOB)], word(500n))])
    expect(events[0]).toMatchObject({
      standard: 'erc20',
      event: 'approval',
      amount_raw: '500',
    })
  })

  it('decodes an ApprovalForAll with its boolean', () => {
    const events = decodeTokenEvents([log([APPROVAL_FOR_ALL, pad(ALICE), pad(BOB)], word(1n))])
    expect(events[0]).toMatchObject({
      standard: 'erc721',
      event: 'approval_for_all',
      approved: true,
    })
  })

  it('skips unknown events silently', () => {
    const other = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
    expect(decodeTokenEvents([log([other, pad(ALICE)], word(1n))])).toEqual([])
  })

  it('skips a malformed Transfer whose data is not a single word', () => {
    expect(decodeTokenEvents([log([TRANSFER, pad(ALICE), pad(BOB)], '0x')])).toEqual([])
  })

  it('returns EIP-55 checksummed participant addresses', () => {
    const events = decodeTokenEvents([
      log([TRANSFER, pad(ALICE.toLowerCase()), pad(BOB.toLowerCase())], word(1n)),
    ])
    expect(events[0]?.from).toBe(ALICE)
    expect(events[0]?.to).toBe(BOB)
  })
})

describe('describeRevertData', () => {
  const encodeErrorString = (msg: string): `0x${string}` => {
    const hex = Buffer.from(msg, 'utf8').toString('hex')
    const len = msg.length.toString(16).padStart(64, '0')
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
    return `0x08c379a0${'20'.padStart(64, '0')}${len}${padded}`
  }

  it('decodes a standard Error(string) revert', () => {
    const described = describeRevertData(
      encodeErrorString('ERC20: transfer amount exceeds balance'),
    )
    expect(described).toBe('reverted with reason: "ERC20: transfer amount exceeds balance"')
  })

  it('decodes a Panic code with its meaning', () => {
    const data = `0x4e487b71${'11'.padStart(64, '0')}` as const
    expect(describeRevertData(data)).toBe(
      'reverted with Panic(0x11): arithmetic overflow or underflow',
    )
  })

  it('reports a custom error as selector + data, honestly undecoded', () => {
    const data = `0xdeadbeef${'ff'.repeat(32)}` as const
    const described = describeRevertData(data)
    expect(described).toContain('custom error 0xdeadbeef')
    expect(described).toContain('requires the contract ABI')
  })

  it('explains empty revert data', () => {
    expect(describeRevertData('0x')).toContain('no revert data')
  })
})
