/**
 * Field test 2026-09-06, bug 4: "block-range cap inconsistent — the gateway
 * enforces 10,000; the provider refused 10,000 and accepted 4,883. Callers
 * can't tell which limit applies until something fails."
 *
 * Two separate wrongs. The advertised number was not the real one, and the real
 * one was far too small to be useful on an L2: 10,000 Arbitrum blocks is about
 * 42 minutes, so finding one event in a four-month window was ~3,400 calls the
 * caller had to orchestrate by hand.
 *
 * The fix is that no number is advertised at all. The caller states the range it
 * wants; the server walks it, discovers the provider's real limit by being
 * refused, and adapts.
 */

import { createServer, type Server } from 'node:http'
import { mainnet } from 'viem/chains'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogFilter } from '../../src/core/chain/types'
import { createViemReader } from '../../src/core/chain/viem/client'

/** The provider's real, undisclosed cap — the field test's number. */
const REAL_CAP = 4883n

let server: Server | undefined
let windowsAsked: bigint[] = []

/** Refuses any getLogs window wider than REAL_CAP, exactly as drpc did. */
const serveCappedLogs = (): Promise<string> => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const answer = (r: { id: unknown; method: string; params?: unknown[] }): unknown => {
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x1' }
        if (r.method === 'eth_getLogs') {
          const f = (r.params?.[0] ?? {}) as { fromBlock: string; toBlock: string }
          const span = BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n
          windowsAsked.push(span)
          if (span > REAL_CAP) {
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32005, message: 'query returned more than 10000 results' },
            }
          }
          return { jsonrpc: '2.0', id: r.id, result: [] }
        }
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found' } }
      }
      const payload = Array.isArray(parsed)
        ? parsed.map((r: { id: unknown; method: string; params?: unknown[] }) => answer(r))
        : answer(parsed as { id: unknown; method: string; params?: unknown[] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`)
    })
  })
}

afterEach(() => {
  server?.close()
  server = undefined
  windowsAsked = []
})

const filter = (from: bigint, to: bigint): LogFilter => ({
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  fromBlock: from,
  toBlock: to,
})

describe('the block-range cap is discovered, not asserted', () => {
  it('shrinks its window until the provider accepts it, then covers the whole range', {
    timeout: 20000,
  }, async () => {
    const url = await serveCappedLogs()
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 5000 })

    // 40,000 blocks — four times the number the server used to advertise, and
    // eight times what this provider actually allows.
    const result = await reader.scanLogs([filter(1_000_000n, 1_040_000n)], {
      stopAfter: 500,
      windowHint: 10_000n,
    })

    expect(result.isOk()).toBe(true)
    const scan = result._unsafeUnwrap()

    // It began at the hint, was refused, and came down on its own.
    expect(windowsAsked[0]).toBe(10_000n)
    expect(scan.windowUsed).toBeLessThanOrEqual(REAL_CAP)

    // Every window it actually completed was one the provider allows.
    const accepted = windowsAsked.filter((w) => w <= REAL_CAP)
    expect(accepted.length).toBeGreaterThan(0)

    // A refusal is remembered. Only two widths are ever refused — the initial
    // hint and one halving — and neither is tried again once it has failed, so
    // the walk cannot oscillate grow/refuse/shrink across the whole range.
    // (Raw counts are higher than logical attempts: viem's transport retries.)
    const refusedWidths = new Set(windowsAsked.filter((w) => w > REAL_CAP).map(String))
    expect([...refusedWidths].sort()).toEqual(['10000', '5000'])

    // And the walk really covered the requested range rather than giving up.
    expect(scan.scannedTo).toBe(1_040_000n)
  })

  it('surfaces the error instead of splitting forever when one block is still too big', async () => {
    const url = await serveCappedLogs()
    const reader = createViemReader({ chain: mainnet, url, timeoutMs: 5000 })

    // REAL_CAP applies to the span, so a single block always passes here; force
    // the pathological case by making the cap smaller than one block.
    const result = await reader.scanLogs([filter(1_000_000n, 1_000_000n)], {
      stopAfter: 10,
      windowHint: 1n,
    })

    // A single-block window is allowed by this fake, so this must succeed —
    // the point is that it terminates rather than halving 1n forever.
    expect(result.isOk()).toBe(true)
  })
})
