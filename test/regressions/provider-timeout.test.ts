import { createServer, type Server } from 'node:http'
import { mainnet } from 'viem/chains'
import { afterEach, describe, expect, it } from 'vitest'
import type { Address } from '../../src/core/chain/types'
import { createViemReader } from '../../src/core/chain/viem/client'
import { mapViemError } from '../../src/core/chain/viem/map-error'

const VITALIK = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as Address
let server: Server | undefined

/** Reproduces drpc's free-tier timeout exactly: JSON-RPC error code 30. */
const serveError = (code: number, message: string, status = 200): Promise<string> => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const answer = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code, message } })
      const payload = Array.isArray(parsed)
        ? parsed.map((r: { id: unknown }) => answer(r.id))
        : answer((parsed as { id: unknown }).id)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`)
    })
  })
}

afterEach(() => {
  server?.close()
  server = undefined
})

describe('campaign bug 5: a provider timeout is transient, whatever code it arrives under', () => {
  it('classifies drpc code 30 "Request timeout on the free plan" as retryable', async () => {
    const url = await serveError(30, 'Request timeout on the free plan')
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })

    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()

    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(e.retryable).toBe(true)
    expect(e.hint).not.toContain('will fail again')
  })

  /**
   * The fixture that hid the bug. The case above passed for weeks against
   * 'Request timeout on the free plan' — but drpc actually sends 'Request
   * timeout on the free plan, please upgrade to paid plan', and those extra
   * words used to flip a literal TIMEOUT to non-retryable, because "upgrade"
   * sat inside the quota pattern. Fixtures here are now verbatim.
   */
  it('classifies the REAL drpc timeout string, billing upsell and all, as retryable', async () => {
    const url = await serveError(
      30,
      'Request timeout on the free plan, please upgrade to paid plan',
    )
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })

    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()

    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(e.retryable).toBe(true)
    expect(e.hint).not.toContain('will fail again')
  })

  it('treats an exhausted usage allowance as transient WITH a wait, not as a refusal', async () => {
    const url = await serveError(
      -32001,
      "You've reached the usage limit for your current plan. To continue with higher limits and uninterrupted access, please upgrade here: https://www.1rpc.io/#pricing",
    )
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })

    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()

    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(e.retryable).toBe(true)
    expect(e.retryAfterMs ?? 0).toBeGreaterThan(0)
  })

  it('still refuses a plan gate: a method the plan excludes is not a waiting game', async () => {
    const url = await serveError(-32004, 'this method requires a paid plan')
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })

    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()

    expect(e.retryable).toBe(false)
  })
})

describe('a timeout stays transient whatever error class carries it', () => {
  const cases: [string, number, string][] = [
    ['drpc free-tier timeout, code 30', 30, 'Request timeout on the free plan'],
    ['as a rate-limit class, code -32005', -32005, 'Request timeout on the free plan'],
    ['as invalid-params class, code -32602', -32602, 'upstream error: timed out'],
    ['generic overload', -32000, 'Node is overloaded, try again'],
    ['no healthy upstream', -32603, 'no healthy upstream available'],
  ]

  for (const [name, code, message] of cases) {
    it(`classifies ${name} as retryable`, async () => {
      const url = await serveError(code, message)
      const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })
      const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
      expect(e.category, `${name} -> ${e.category}`).toBe('UPSTREAM_TRANSIENT')
      expect(e.retryable).toBe(true)
      expect(e.hint).not.toContain('will fail again')
    })
  }

  it('keeps a batch-size cap deterministic — the original retry-spiral must not regress', async () => {
    const url = await serveError(-32005, 'batch size limit exceeded: max 3 requests per batch')
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })
    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_POLICY')
    expect(e.retryable).toBe(false)
  })

  it('keeps an unsupported method deterministic', async () => {
    const url = await serveError(-32601, 'the method debug_traceTransaction does not exist')
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })
    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
    expect(e.category).toBe('UNSUPPORTED')
    expect(e.retryable).toBe(false)
  })
})

describe('the transient path must not leak the provider URL', () => {
  it('never emits the API key even when classifying from the raw error text', async () => {
    const url = await serveError(30, 'Request timeout on the free plan')
    const secret = `${url}/v3/super-secret-api-key`
    const reader = createViemReader({ chain: mainnet, url: secret, timeoutMs: 2000 })
    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(JSON.stringify(e)).not.toContain('super-secret-api-key')
  })
})

describe('campaign 2: the provider telling us to retry is decisive', () => {
  it('classifies code 19 "Temporary internal error. Please retry" as retryable', async () => {
    const url = await serveError(19, 'Temporary internal error. Please retry')
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })
    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(e.retryable).toBe(true)
  })

  it('leaves code 12 routing rejections deterministic — narrowing the range is the fix', async () => {
    const url = await serveError(12, "Can't route your request to the upstream: range too large")
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 2000 })
    const e = (await reader.account(VITALIK, 19000000n))._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_POLICY')
    expect(e.retryable).toBe(false)
  })
})

describe('campaign bug 8: an oversized response is the caller fixable, not a server fault', () => {
  const oversized = [
    'HTTP response body exceeded the size limit.',
    'query returned more than 10000 results',
    'result set too large, please narrow your query',
    'response payload too large',
  ]

  for (const message of oversized) {
    it(`classifies "${message.slice(0, 34)}…" as a deterministic, fixable rejection`, () => {
      const mapped = mapViemError(new Error(message))
      expect(mapped.category).toBe('UPSTREAM_POLICY')
      expect(mapped.category).not.toBe('INTERNAL')
      expect(mapped.retryable).toBe(false)
      expect(mapped.hint).toContain('narrow')
      expect(mapped.hint).not.toContain('server-side bug')
    })
  }

  it('does not mistake an oversized result for a rate limit', () => {
    // "too many results" must not be caught by the "too many requests" rule
    const mapped = mapViemError(new Error('too many results for this range'))
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.retryable).toBe(false)
  })

  it('still treats too many REQUESTS as transient', () => {
    const mapped = mapViemError(new Error('too many requests, slow down'))
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryable).toBe(true)
  })
})
