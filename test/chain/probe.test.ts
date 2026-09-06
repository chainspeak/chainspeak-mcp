import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeUpstream } from '../../src/core/chain/probe'

interface Behavior {
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
  it('measures a generous endpoint at the probe ceiling of 10', async () => {
    const url = await serve({ batchCap: 100 })
    expect(await probeUpstream(url, 2000)).toEqual({ batchCap: 10 })
  })

  it('measures a drpc-style batch cap of 3', async () => {
    const url = await serve({ batchCap: 3 })
    expect(await probeUpstream(url, 2000)).toEqual({ batchCap: 3 })
  })

  it('falls back to batch cap 1 when all batches are rejected', async () => {
    const url = await serve({ batchCap: 0 })
    const caps = await probeUpstream(url, 2000)
    expect(caps.batchCap).toBe(1)
  })

  it('degrades to all-null on an unreachable endpoint instead of failing', async () => {
    const caps = await probeUpstream('http://127.0.0.1:9/', 500)
    expect(caps).toEqual({ batchCap: null })
  })
})
