import { describe, expect, it } from 'vitest'
import { scaleUnits, weiToDual, weiToGwei } from '../../src/core/chain/format'

describe('scaleUnits', () => {
  const cases: Array<[bigint, number, string]> = [
    [0n, 18, '0'],
    [0n, 0, '0'],
    [0n, 9, '0'],
    [42n, 0, '42'],
    [1000n, 0, '1000'],
    [1_000_000_000_000_000_000n, 18, '1'],
    [1_000_000_000n, 9, '1'],
    [2_000_000_000_000_000_000n, 18, '2'],
    [1_500_000_000_000_000_000n, 18, '1.5'],
    [1_050_000_000_000_000_000n, 18, '1.05'],
    [1_230_000_000n, 9, '1.23'],
    [1n, 18, '0.000000000000000001'],
    [1n, 9, '0.000000001'],
    [500n, 2, '5'],
    [5n, 2, '0.05'],
    [123n, 4, '0.0123'],
    [123_456_789_000_000_000_000n, 18, '123.456789'],
    [-1_500_000_000_000_000_000n, 18, '-1.5'],
    [-1n, 18, '-0.000000000000000001'],
    [-500n, 2, '-5'],
    [-42n, 0, '-42'],
    [1n, 36, '0.000000000000000000000000000000000001'],
    [1_000_000_000_000_000_000_000_000_000_000_000_000n, 36, '1'],
  ]

  it.each(cases)('scaleUnits(%s, %i) → %s', (value, decimals, expected) => {
    expect(scaleUnits(value, decimals)).toBe(expected)
  })
})

describe('weiToDual', () => {
  it('returns raw wei string and ether decimal string', () => {
    expect(weiToDual(1_500_000_000_000_000_000n)).toEqual({
      wei: '1500000000000000000',
      native: '1.5',
    })
  })

  it('handles 1 wei', () => {
    expect(weiToDual(1n)).toEqual({ wei: '1', native: '0.000000000000000001' })
  })

  it('handles zero', () => {
    expect(weiToDual(0n)).toEqual({ wei: '0', native: '0' })
  })
})

describe('weiToGwei', () => {
  it('scales by 10^9', () => {
    expect(weiToGwei(1_500_000_000n)).toBe('1.5')
  })

  it('handles zero', () => {
    expect(weiToGwei(0n)).toBe('0')
  })

  it('handles sub-gwei values', () => {
    expect(weiToGwei(1n)).toBe('0.000000001')
  })
})
