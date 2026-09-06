import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Address, Hash, TransactionData } from '../../src/core/chain/types'
import { createViemReader } from '../../src/core/chain/viem/client'

const ZERO_HASH = `0x${'00'.repeat(32)}`
const REAL_HASH = `0x${'ab'.repeat(32)}` as Hash

// Error(string) payload for "nope"
const NOPE_DATA = `0x08c379a0${'20'.padStart(64, '0')}${'4'.padStart(64, '0')}${'6e6f7065'.padEnd(64, '0')}`

interface Behavior {
  /** what the trace call answers. There is no probe any more — this IS the call. */
  realTrace: 'works' | 'fails' | 'method-not-found'
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
      const answer = (r: { id: unknown; method: string; params?: unknown[] }): unknown => {
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x1' }
        if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0x0' }
        if (r.method === 'debug_traceTransaction') {
          const hash = r.params?.[0]
          if (hash === ZERO_HASH) {
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32000, message: 'transaction not found' },
            }
          }
          if (behavior.realTrace === 'works') {
            return {
              jsonrpc: '2.0',
              id: r.id,
              result: { type: 'CALL', error: 'execution reverted', output: NOPE_DATA },
            }
          }
          if (behavior.realTrace === 'method-not-found') {
            return {
              jsonrpc: '2.0',
              id: r.id,
              error: {
                code: -32601,
                message: 'the method debug_traceTransaction does not exist/is not available',
              },
            }
          }
          return {
            jsonrpc: '2.0',
            id: r.id,
            error: { code: -32000, message: 'trace timeout exceeded' },
          }
        }
        if (r.method === 'eth_call') {
          return {
            jsonrpc: '2.0',
            id: r.id,
            error: { code: 3, message: 'execution reverted: nope', data: NOPE_DATA },
          }
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

const failedTx: TransactionData = {
  hash: REAL_HASH,
  status: 'failed',
  from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address,
  to: '0x28C6c06298d514Db089934071355E5743bf21d60' as Address,
  createdContract: null,
  valueWei: 0n,
  nonce: 1,
  txType: 'eip1559',
  authorizationList: null,
  maxFeePerBlobGasWei: null,
  blobVersionedHashes: null,
  blobGasUsed: null,
  blobGasPriceWei: null,
  gasLimit: 100000n,
  input: '0x',
  maxFeePerGasWei: null,
  maxPriorityFeePerGasWei: null,
  blockNumber: 19000000n,
  gasUsed: 100000n,
  effectiveGasPriceWei: 1n,
  logs: [],
}

describe('failure-analysis ladder (integration; trace is attempted, never probed)', () => {
  it('uses trace when the real trace call answers', { timeout: 15000 }, async () => {
    const url = await serve({ realTrace: 'works' })
    const reader = createViemReader({ url, timeoutMs: 3000 })

    const analysis = (await reader.analyzeFailure(failedTx))._unsafeUnwrap()

    expect(analysis.method).toBe('trace')
    expect(analysis.confidence).toBe('exact')
    expect(analysis.reason).toBe('reverted with reason: "nope"')
    expect(analysis.note).toBeNull()
  })

  it('falls back to replay WITH a receipt when the trace call fails', {
    timeout: 15000,
  }, async () => {
    const url = await serve({ realTrace: 'fails' })
    const reader = createViemReader({ url, timeoutMs: 3000 })

    const analysis = (await reader.analyzeFailure(failedTx))._unsafeUnwrap()

    expect(analysis.method).toBe('replay')
    expect(analysis.confidence).toBe('approximate')
    expect(analysis.reason).toBe('reverted with reason: "nope"')
    // the field-test defect: this must never be a silent fallback
    expect(analysis.note).toContain('replay used')
    expect(analysis.note).toContain('trace was unavailable')

    // A transient trace failure says nothing about the method. The old note
    // asserted "a node without debug_traceTransaction" for what could just as
    // easily be a quota block — that claim must not come back.
    expect(analysis.note).not.toContain('without debug_traceTransaction')
    expect(analysis.note).toContain('not a statement about whether the endpoint supports')
  })

  it('only claims the method is missing when the node itself said so', {
    timeout: 15000,
  }, async () => {
    const url = await serve({ realTrace: 'method-not-found' })
    const reader = createViemReader({ url, timeoutMs: 3000 })

    const analysis = (await reader.analyzeFailure(failedTx))._unsafeUnwrap()

    expect(analysis.method).toBe('replay')
    // -32601 IS the node answering about the method, so this assertion is earned
    expect(analysis.note).toContain('does not offer debug_traceTransaction')
  })
})
