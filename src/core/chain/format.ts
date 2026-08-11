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

/** Raw integer plus its decimal rendering in the chain's native unit. */
export function weiToDual(wei: bigint, decimals = 18): { wei: string; native: string } {
  return { wei: wei.toString(), native: scaleUnits(wei, decimals) }
}

export function weiToGwei(wei: bigint): string {
  return scaleUnits(wei, 9)
}
