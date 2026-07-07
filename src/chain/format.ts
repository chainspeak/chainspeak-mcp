export function scaleUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const boundary = digits.length - decimals
  const intPart = digits.slice(0, boundary)
  const fracPart = digits.slice(boundary).replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`
}

export function weiToDual(wei: bigint): { wei: string; eth: string } {
  return { wei: wei.toString(), eth: scaleUnits(wei, 18) }
}

export function weiToGwei(wei: bigint): string {
  return scaleUnits(wei, 9)
}
