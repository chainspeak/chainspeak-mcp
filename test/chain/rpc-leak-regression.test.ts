import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Address } from '../../src/core/chain/types'
import { createViemReader } from '../../src/core/chain/viem/client'

const SECRET_PATH = '/v3/super-secret-api-key'
const VITALIK: Address = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'

let server: Server | undefined

const serveRpcError = (code: number, message: string): Promise<string> => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const answer = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code, message } })
      const payload = Array.isArray(parsed)
        ? parsed.map((r: { id: unknown }) => answer(r.id))
        : answer((parsed as { id: unknown }).id)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => {
    server?.listen(0, () => {
      const address = server?.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}${SECRET_PATH}`)
    })
  })
}

afterEach(() => {
  server?.close()
  server = undefined
})

describe('unmapped provider error codes (leak regression)', () => {
  it('maps an unknown code to UPSTREAM_POLICY and never leaks the URL', {
    timeout: 15000,
  }, async () => {
    const url = await serveRpcError(-32097, 'daily request cap reached')
    const reader = createViemReader({ url, timeoutMs: 2000 })
    const result = await reader.account(VITALIK, 19000000n)
    expect(result.isErr()).toBe(true)
    const e = result._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_POLICY')
    expect(JSON.stringify(e)).not.toContain('super-secret-api-key')
  })

  it('maps a 429-in-body rate limit to rate_limited without leaking the URL', {
    timeout: 15000,
  }, async () => {
    const url = await serveRpcError(429, 'too many requests')
    const reader = createViemReader({ url, timeoutMs: 2000 })
    const result = await reader.account(VITALIK, 19000000n)
    expect(result.isErr()).toBe(true)
    const e = result._unsafeUnwrapErr()
    expect(e.category).toBe('UPSTREAM_TRANSIENT')
    expect(JSON.stringify(e)).not.toContain('super-secret-api-key')
  })
})
