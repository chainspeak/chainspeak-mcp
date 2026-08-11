import type { ChainError } from '../chain/errors'

/**
 * Render an error for the agent as structured JSON: {category, retryable, message, hint}.
 * The hint always says what to CHANGE; `retryable: true` appears only on
 * UPSTREAM_TRANSIENT failures that were already retried server-side.
 */
export const renderToolError = (e: ChainError): string =>
  JSON.stringify({
    error: {
      category: e.category,
      retryable: e.retryable,
      ...(e.retryable && e.retryAfterMs != null ? { retry_after_ms: e.retryAfterMs } : {}),
      message: e.message,
      hint: e.hint,
    },
  })
