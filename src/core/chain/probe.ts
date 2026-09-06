/**
 * Feature-detect the endpoint rather than assume: callers bring their own RPC,
 * and batch caps and debug_ methods vary by provider. Every answer degrades to
 * null — a failed probe must never break the server.
 *
 * **There is deliberately no `archive` probe.** There used to be one, and it
 * lied. It read ANY JSON-RPC error at an old block as "not an archive node", so
 * a free-tier quota message ("you've reached the usage limit … please upgrade")
 * came back as `archive: false` from an endpoint whose archive reads worked
 * fine — and because the answer was cached, one wrong probe steered entire
 * sessions around a limit that did not exist. Block 1 was the wrong question
 * anyway: an Arbitrum Nitro node cannot serve pre-migration state while being a
 * perfectly good archive node for every block after it.
 *
 * The replacement is not a better probe, it is no probe. Treat every endpoint as
 * archive-capable, attempt the historical read, and let the real failure speak:
 * a node that genuinely lacks the state says so in words `mapViemError`
 * recognises, and that becomes HISTORICAL_STATE_UNAVAILABLE with a hint saying
 * what to do next. An error we do not recognise stays an unknown error — it is
 * never converted back into a capability claim.
 */

export interface UpstreamCapabilities {
  /** does this endpoint offer debug_traceTransaction? null = probe failed */
  trace: boolean | null
  /** largest probed JSON-RPC batch size that succeeds (10, 3, or 1); null = probe failed */
  batchCap: number | null
}

const ZERO_HASH = `0x${'00'.repeat(32)}`

interface RpcResponse {
  result?: unknown
  error?: { code?: number; message?: string }
}

const post = async (url: string, body: unknown, timeoutMs: number): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  // Some providers put a JSON-RPC error body behind a non-2xx status
  // (publicnode answers archive requests with HTTP 403 + a proper error object) —
  // a parseable body is an answer either way.
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
}

const call = (method: string, params: unknown[], id = 1): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

const METHOD_MISSING =
  /method not (found|supported|available|allowed)|does not exist|not implemented|disabled|unsupported|restricted|no such method/i

/**
 * Trace support: call debug_traceTransaction on the zero hash. A supporting
 * node answers with a TRANSACTION-level error (unknown tx); a node without the
 * method answers method-not-found (-32601) or a "disabled/not allowed" message.
 */
const probeTrace = async (url: string, timeoutMs: number): Promise<boolean | null> => {
  try {
    const res = (await post(
      url,
      call('debug_traceTransaction', [ZERO_HASH, { tracer: 'callTracer' }]),
      timeoutMs,
    )) as RpcResponse
    if (res.error === undefined) return true // improbable, but a non-error answer proves support
    if (res.error.code === -32601) return false
    return !METHOD_MISSING.test(res.error.message ?? '')
  } catch {
    return null
  }
}

/** Largest batch of eth_chainId calls the provider accepts: 10 → 3 → 1. */
const probeBatchCap = async (url: string, timeoutMs: number): Promise<number | null> => {
  const attempt = async (n: number): Promise<boolean> => {
    const batch = Array.from({ length: n }, (_, i) => call('eth_chainId', [], i + 1))
    try {
      const res = await post(url, batch, timeoutMs)
      return (
        Array.isArray(res) &&
        res.length === n &&
        res.every((r: RpcResponse) => r.error === undefined)
      )
    } catch {
      return false
    }
  }
  try {
    if (await attempt(10)) return 10
    if (await attempt(3)) return 3
    const single = (await post(url, call('eth_chainId', []), timeoutMs)) as RpcResponse
    return single.error === undefined ? 1 : null
  } catch {
    return null
  }
}

export const probeUpstream = async (
  url: string,
  timeoutMs = 5000,
): Promise<UpstreamCapabilities> => {
  const [trace, batchCap] = await Promise.all([
    probeTrace(url, timeoutMs),
    probeBatchCap(url, timeoutMs),
  ])
  return { trace, batchCap }
}
