/**
 * What is left of feature detection: the JSON-RPC batch cap, and nothing else.
 *
 * **Two probes were deleted, not repaired — `archive` and `trace`.** Both asked
 * a capability question up front, read whatever error came back as an answer,
 * and cached it. Both were wrong in the field, in opposite directions:
 *
 * - `archive` failed CLOSED. Any JSON-RPC error at an old block became "not an
 *   archive node", so a free-tier quota message ("you've reached the usage limit
 *   … please upgrade") came back as `archive: false` from an endpoint whose
 *   historical reads worked fine. Block 1 was the wrong question anyway: an
 *   Arbitrum Nitro node cannot serve pre-migration state while being a perfectly
 *   good archive node for every block after it.
 * - `trace` failed OPEN. Any error that was not method-not-found became "yes,
 *   this endpoint has debug_traceTransaction" — so the same quota message
 *   claimed a capability instead of denying one.
 *
 * The lesson is not "write a better probe". It is that a probe answers a
 * question nobody asked yet, using an error whose cause it cannot see, and then
 * caches the guess. So: attempt the real operation and let the real failure
 * speak. A node that truly lacks archive state or truly lacks a method says so
 * in words `mapViemError` recognises. An error we do not recognise stays an
 * unknown error — it is never converted back into a capability claim.
 *
 * `batchCap` survives because it is not a guess: it is measured by doing the
 * exact thing it reports on (sending a batch of that size and seeing it work),
 * and a wrong answer degrades to a smaller batch rather than a false statement.
 */

export interface UpstreamCapabilities {
  /** largest probed JSON-RPC batch size that succeeds (10, 3, or 1); null = probe failed */
  batchCap: number | null
}

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
): Promise<UpstreamCapabilities> => ({
  batchCap: await probeBatchCap(url, timeoutMs),
})
