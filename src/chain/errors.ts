export type ChainError =
  | { tag: 'transport'; message: string }
  | { tag: 'rate_limited'; message: string; retryAfterMs: number | null }
  | { tag: 'rpc'; message: string; code: number | null }
  | { tag: 'invalid_input'; message: string }
  | { tag: 'internal'; message: string }

export const transportError = (message: string): ChainError => ({ tag: 'transport', message })

export const rateLimitedError = (message: string, retryAfterMs: number | null): ChainError => ({
  tag: 'rate_limited',
  message,
  retryAfterMs,
})

export const rpcError = (message: string, code: number | null): ChainError => ({
  tag: 'rpc',
  message,
  code,
})

export const invalidInputError = (message: string): ChainError => ({
  tag: 'invalid_input',
  message,
})

export const internalError = (message: string): ChainError => ({ tag: 'internal', message })

export const wrapChainError = (context: string, e: ChainError): ChainError => ({
  ...e,
  message: `${context}: ${e.message}`,
})
