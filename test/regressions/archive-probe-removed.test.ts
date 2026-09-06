/**
 * Field test 2026-09-06: `chain_status.upstream.archive` reported FALSE on an
 * endpoint whose archive reads worked fine, and the session designed workarounds
 * around a limit that did not exist.
 *
 * Reproduced live against arbitrum.drpc.org: `eth_getBalance(…, 0x1)` answered
 *
 *   -32001 "You've reached the usage limit for your current plan … please upgrade"
 *
 * while `eth_getBalance(…, 0x2000000)` returned a balance. The old probe read
 * "any JSON-RPC error" as "not an archive node", so a BILLING message became a
 * CAPABILITY claim — and it was cached, so it stayed wrong.
 *
 * The fix was removal, not repair: there is no archive probe and no archive
 * field. These tests keep it that way.
 */

import { createServer, type Server } from 'node:http'
import { RpcRequestError } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import { probeUpstream } from '../../src/core/chain/probe'
import { mapViemError } from '../../src/core/chain/viem/map-error'

/** Verbatim from arbitrum.drpc.org on 2026-09-06. */
const QUOTA_MESSAGE =
  "You've reached the usage limit for your current plan. To continue with higher limits and uninterrupted access, please upgrade here: https://www.1rpc.io/#pricing"

let server: Server | undefined
const methodsSeen: string[] = []

/** Answers every method with the real quota error, so any probe that asks gets a lie. */
const serveQuota = (): Promise<string> => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const answer = (r: { id: unknown; method: string }): unknown => {
        methodsSeen.push(r.method)
        return { jsonrpc: '2.0', id: r.id, error: { code: -32001, message: QUOTA_MESSAGE } }
      }
      const payload = Array.isArray(parsed)
        ? parsed.map((r: { id: unknown; method: string }) => answer(r))
        : answer(parsed as { id: unknown; method: string })
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
  methodsSeen.length = 0
})

describe('the capability probes are gone, and cannot come back', () => {
  it('reports only the measured batch cap — archive and trace absent, not false, not null', async () => {
    const url = await serveQuota()
    const caps = await probeUpstream(url, 2000)

    expect(Object.keys(caps)).toEqual(['batchCap'])
    expect('archive' in caps).toBe(false)
    expect('trace' in caps).toBe(false)
  })

  it('asks no capability question at all, so a quota reply cannot become a capability claim', async () => {
    const url = await serveQuota()
    await probeUpstream(url, 2000)

    // eth_getBalance was the archive probe and failed CLOSED on this error;
    // debug_traceTransaction was the trace probe and failed OPEN on it. Neither
    // may be asked up front: capability is learned from the operation the
    // caller actually wanted.
    expect(methodsSeen).not.toContain('eth_getBalance')
    expect(methodsSeen).not.toContain('debug_traceTransaction')
    expect(new Set(methodsSeen)).toEqual(new Set(['eth_chainId']))
  })

  it('a genuine pruned-state reply is still a clear, steering answer', () => {
    const mapped = mapViemError(
      new RpcRequestError({
        body: {},
        url: 'https://rpc.test',
        error: { code: -32000, message: 'missing trie node deadbeef, state is not available' },
      }),
    )

    expect(mapped.category).toBe('HISTORICAL_STATE_UNAVAILABLE')
    expect(mapped.hint).toContain('closer to the head')
  })

  it('a quota reply is NOT mistaken for a history limit', () => {
    const mapped = mapViemError(
      new RpcRequestError({
        body: {},
        url: 'https://rpc.test',
        error: { code: -32001, message: QUOTA_MESSAGE },
      }),
    )

    // Whatever else it is, it must never claim the endpoint has no history.
    expect(mapped.category).not.toBe('HISTORICAL_STATE_UNAVAILABLE')
  })
})
