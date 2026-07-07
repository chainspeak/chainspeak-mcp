import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { requireBearer } from '../src/mcp/http-auth'
import { buildServer } from '../src/server'
import { createFakeReader, silentLogger } from './fakes/chain-reader'

const TOKEN = 'test-token-0123456789abcdef'

const buildGuardedFetch = () => {
  const reader = createFakeReader()
  const handler = createMcpHandler(() =>
    buildServer({ readerFor: () => ok(reader), log: silentLogger }),
  )
  return requireBearer(TOKEN, (req) => handler.fetch(req))
}

const connect = async (guarded: (req: Request) => Promise<Response>) => {
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
    fetch: (url: string | URL | Request, init?: RequestInit) => guarded(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  })
  const client = new Client({ name: 'http-e2e-client', version: '0.0.0' })
  await client.connect(transport)
  return client
}

describe('http e2e', () => {
  it('rejects requests without a bearer token', async () => {
    const guarded = buildGuardedFetch()
    const res = await guarded(new Request('http://mcp.test/mcp', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token (same length)', async () => {
    const guarded = buildGuardedFetch()
    const res = await guarded(
      new Request('http://mcp.test/mcp', {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}X` },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('serves a full tool call with a valid token', async () => {
    const client = await connect(buildGuardedFetch())
    const res = await client.callTool({
      name: 'eth_get_balance',
      arguments: { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
    })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ wei: '1500000000000000000', eth: '1.5' })
    await client.close()
  })
})
