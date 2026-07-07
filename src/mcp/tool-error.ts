import type { ChainError } from '../chain/errors'

export const renderToolError = (e: ChainError): string => {
  switch (e.tag) {
    case 'transport':
      return `Temporary network problem reaching the RPC endpoint (${e.message}). This is transient — retry the call.`
    case 'rate_limited': {
      const after =
        e.retryAfterMs === null ? 'a few seconds' : `${Math.ceil(e.retryAfterMs / 1000)}s`
      return `The RPC provider rate-limited this request. Wait ${after} and retry.`
    }
    case 'rpc':
      return `The RPC provider rejected the request${e.code === null ? '' : ` (code ${e.code})`}: ${e.message}. Retrying will not help — check the inputs or report the error.`
    case 'invalid_input':
      return `Invalid input: ${e.message}`
    case 'internal':
      return 'Internal server error. Retrying will not help — check the server logs (stderr).'
  }
}
