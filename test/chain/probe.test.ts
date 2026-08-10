import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeUpstream } from '../../src/core/chain/probe'

interface Behavior {
  archive: 'ok' | 'pruned'
  trace: 'ok' | 'method-not-found' | 'disabled'
  batchCap: number
}

let server: Server | undefined

const serve = (behavior: Behavior): Promise<string> => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const answer = (r: { id: unknown; method: string }): unknown => {
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x1' }
        if (r.method === 'eth_getBalance') {
          return behavior.archive === 'ok'
            ? { jsonrpc: '2.0', id: r.id, result: '0x0' }
            : {
                jsonrpc: '2.0',
                id: r.id,
                error: {
                  code: -32000,
                  message: 'missing trie node deadbeef (path) state is not available',
                },
              }
        }
        if (r.method === 'debug_traceTransaction') {
          if (behavior.trace === 'method-not-found')
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: {
                code: -32601,
                message: 'the method debug_traceTransaction does not exist/is not available',
              },
            }
          if (behavior.trace === 'disabled')
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: {
                code: -32000,
                message: 'debug_traceTransaction is disabled on this endpoint',
              },
            }
          return {
            jsonrpc: '2.0',
            id: r.id,
            error: { code: -32000, message: 'transaction 0x00… not found' },
          }
        }
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found' } }
      }
      const payload = Array.isArray(parsed)
        ? parsed.length > behavior.batchCap
          ? {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32005,
                message: `batch of more than ${behavior.batchCap} requests is not allowed`,
              },
            }
          : parsed.map((r: { id: unknown; method: string }) => answer(r))
        : answer(parsed as { id: unknown; method: string })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => {
    server?.listen(0, () => {
      const address = server?.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve(`http://127.0.0.1:${port}/`)
    })
  })
}

afterEach(() => {
  server?.close()
  server = undefined
})

describe('probeUpstream', () => {
  it('detects a full-featured endpoint', async () => {
    const url = await serve({ archive: 'ok', trace: 'ok', batchCap: 100 })
    expect(await probeUpstream(url, 2000)).toEqual({ archive: true, trace: true, batchCap: 10 })
  })

  it('detects a pruned node without trace and with a drpc-style batch cap of 3', async () => {
    const url = await serve({ archive: 'pruned', trace: 'method-not-found', batchCap: 3 })
    expect(await probeUpstream(url, 2000)).toEqual({ archive: false, trace: false, batchCap: 3 })
  })

  it('treats a disabled trace method as unsupported', async () => {
    const url = await serve({ archive: 'ok', trace: 'disabled', batchCap: 10 })
    const caps = await probeUpstream(url, 2000)
    expect(caps.trace).toBe(false)
  })

  it('falls back to batch cap 1 when all batches are rejected', async () => {
    const url = await serve({ archive: 'ok', trace: 'ok', batchCap: 0 })
    const caps = await probeUpstream(url, 2000)
    expect(caps.batchCap).toBe(1)
  })

  it('degrades to all-null on an unreachable endpoint instead of failing', async () => {
    const caps = await probeUpstream('http://127.0.0.1:9/', 500)
    expect(caps).toEqual({ archive: null, trace: null, batchCap: null })
  })
})
