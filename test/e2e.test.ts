import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server'
import { createFakeReader, silentLogger } from './fakes/chain-reader'

const connect = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const reader = createFakeReader()
  const server = buildServer({ readerFor: () => ok(reader), log: silentLogger })
  await server.connect(serverTransport)
  const client = new Client({ name: 'e2e-client', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

describe('e2e protocol round trip', () => {
  it('lists all tools with read-only annotations and schemas', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'eth_get_balance',
      'eth_get_chain_info',
      'eth_get_gas_price',
      'eth_get_token_balance',
      'eth_get_transaction',
      'eth_resolve_ens',
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBe(false)
      expect(tool.inputSchema).toBeDefined()
      expect(tool.outputSchema).toBeDefined()
    }
  })

  it('calls eth_get_chain_info and receives structured decimal strings', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'eth_get_chain_info', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({
      chain_id: '1',
      latest_block: '19000000',
      base_fee_wei: '20000000000',
      base_fee_gwei: '20',
    })
  })

  it('calls eth_get_balance with defaults applied', async () => {
    const client = await connect()
    const res = await client.callTool({
      name: 'eth_get_balance',
      arguments: { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
    })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ wei: '1500000000000000000', eth: '1.5' })
  })

  it('rejects a malformed address with a corrective isError result', async () => {
    const client = await connect()
    const res = await client.callTool({
      name: 'eth_get_balance',
      arguments: { address: '0xd8da6b' },
    })
    expect(res.isError).toBe(true)
    const text = res.content?.find((c) => c.type === 'text')
    expect(text?.type === 'text' && text.text).toMatch(/42-character 0x-prefixed hex address/)
  })
})
