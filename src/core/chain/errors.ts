/**
 * `retryable` is true ONLY for UPSTREAM_TRANSIENT, and `hint` must say what to
 * CHANGE — never a bare "try again". UPSTREAM_POLICY means retrying unchanged
 * WILL fail again (batch caps, range caps, exhausted quota).
 */

export type ErrorCategory =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'UPSTREAM_TRANSIENT'
  | 'UPSTREAM_POLICY'
  | 'INTERNAL'

export interface ChainError {
  category: ErrorCategory
  retryable: boolean
  message: string
  hint: string
  /** provider-suggested wait (ms) before a retryable error may succeed; null = unknown */
  retryAfterMs?: number | null
  /**
   * Internal control-flow marker: the failure was a deterministic contract-call
   * rejection (revert, or the function does not exist). Lets callers implement
   * "this token does not expose symbol()" fallbacks. Never rendered to the agent.
   */
  contractCall?: true
}

export const invalidInput = (message: string, hint: string): ChainError => ({
  category: 'INVALID_INPUT',
  retryable: false,
  message,
  hint,
})

export const notFound = (message: string, hint: string): ChainError => ({
  category: 'NOT_FOUND',
  retryable: false,
  message,
  hint,
})

export const unsupported = (message: string, hint: string): ChainError => ({
  category: 'UNSUPPORTED',
  retryable: false,
  message,
  hint,
})

export const upstreamTransient = (
  message: string,
  hint: string,
  retryAfterMs: number | null = null,
): ChainError => ({
  category: 'UPSTREAM_TRANSIENT',
  retryable: true,
  message,
  hint,
  retryAfterMs,
})

export const upstreamPolicy = (message: string, hint: string): ChainError => ({
  category: 'UPSTREAM_POLICY',
  retryable: false,
  message,
  hint,
})

export const internal = (message: string): ChainError => ({
  category: 'INTERNAL',
  retryable: false,
  message,
  hint: 'this is a server-side bug, not something your input caused — do not retry; report it if it persists',
})

export const contractCallFailed = (message: string): ChainError => ({
  category: 'INVALID_INPUT',
  retryable: false,
  message,
  hint: 'the contract rejected this call — check that the address points at the kind of contract this tool expects',
  contractCall: true,
})

export const isContractCallFailure = (e: ChainError): boolean => e.contractCall === true

export const wrapChainError = (context: string, e: ChainError): ChainError => ({
  ...e,
  message: `${context}: ${e.message}`,
})
