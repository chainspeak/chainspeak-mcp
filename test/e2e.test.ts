import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/core/server'
import { createFakeReader, silentLogger, testRegistry } from './fakes/chain-reader'

const connect = async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const reader = createFakeReader()
  const server = buildServer({ registry: testRegistry(reader), log: silentLogger })
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
      'chainspeak_get_account',
      'chainspeak_get_block',
      'chainspeak_get_chain_status',
      'chainspeak_get_events',
      'chainspeak_get_token',
      'chainspeak_get_transaction',
      'chainspeak_resolve_name',
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBe(false)
      expect(tool.inputSchema).toBeDefined()
      expect(tool.outputSchema).toBeDefined()
    }
  })

  it('calls chainspeak_get_chain_status and receives structured decimal strings', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'chainspeak_get_chain_status', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toMatchObject({
      chain: 'ethereum',
      chain_id: '1',
      chain_name: 'Ethereum',
      block_number: '19000000',
      base_fee_wei: '20000000000',
      base_fee_gwei: '20',
      upstream_syncing: false,
    })
  })

  it('calls chainspeak_get_account with defaults applied', async () => {
    const client = await connect()
    const res = await client.callTool({
      name: 'chainspeak_get_account',
      arguments: { address_or_name: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
    })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({
      chain: 'ethereum',
      chain_id: '1',
      block_number: '19000000',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      resolution: null,
      balance_wei: '1500000000000000000',
      balance_native: '1.5',
      native_symbol: 'ETH',
      nonce: 42,
      is_contract: false,
      delegated_to: null,
      ens_name: null,
    })
  })

  it('rejects a malformed address with a corrective isError result', async () => {
    const client = await connect()
    const res = await client.callTool({
      name: 'chainspeak_get_account',
      arguments: { address_or_name: '0xd8da6b' },
    })
    expect(res.isError).toBe(true)
    const text = res.content?.find((c) => c.type === 'text')
    expect(text?.type === 'text' && text.text).toMatch(/42-character/)
  })
})
