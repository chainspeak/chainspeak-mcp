import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { okAsync } from 'neverthrow'
import { base, mainnet, polygon } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import type { ChainEntry } from '../src/core/chain/registry'
import { createChainRegistry } from '../src/core/chain/registry'
import { buildServer } from '../src/core/server'
import { createFakeReader, silentLogger, VITALIK } from './fakes/chain-reader'

const reader = (chainId: bigint, overrides = {}) =>
  createFakeReader({ chainId: () => okAsync(chainId), ...overrides })

const connect = async (entries: readonly ChainEntry[]): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer({ registry: createChainRegistry(entries), log: silentLogger })
  await server.connect(serverTransport)
  const client = new Client({ name: 'chain-selection-test', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

interface Answer {
  chain?: string
  chain_id?: string
  native_symbol?: string
  simple_transfer_cost?: unknown
  gas_tiers?: unknown
  note?: unknown
  /** must stay undefined: the envelope is gone */
  results?: unknown
  failed?: unknown
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Answer; text: string }> => {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.find((c) => c.type === 'text')
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? {}) as Answer,
    text: text?.type === 'text' ? text.text : '',
  }
}

const twoChains = (): ChainEntry[] => [
  { chain: mainnet, reader: reader(1n) },
  { chain: base, reader: reader(8453n) },
]

describe('chain selection', () => {
  it('answers for one chain, flat, saying which chain it answered for', async () => {
    const client = await connect(twoChains())
    const { body } = await call(client, 'chainspeak_get_account', { address_or_name: VITALIK })

    expect(body.chain).toBe('ethereum')
    expect(body.chain_id).toBe('1')
    // no envelope: the answer is the answer, not a list of them
    expect(body.results).toBeUndefined()
    expect(body.failed).toBeUndefined()
    await client.close()
  })

  it('defaults to the registry default chain', async () => {
    const client = await connect(twoChains())
    const { body } = await call(client, 'chainspeak_get_block', { block: 'latest' })
    expect(body.chain).toBe('ethereum')
    await client.close()
  })

  it('honours an explicit chain name and a chain id', async () => {
    const client = await connect(twoChains())

    const byName = await call(client, 'chainspeak_get_account', {
      address_or_name: VITALIK,
      chain: 'base',
    })
    expect(byName.body.chain).toBe('base')
    expect(byName.body.chain_id).toBe('8453')

    const byId = await call(client, 'chainspeak_get_account', {
      address_or_name: VITALIK,
      chain: '8453',
    })
    expect(byId.body.chain).toBe('base')
    await client.close()
  })

  it('enumerates the configured chains in the tool schema so the agent need not guess', async () => {
    const client = await connect(twoChains())
    const { tools } = await client.listTools()
    const schema = JSON.stringify(
      tools.find((t) => t.name === 'chainspeak_get_account')?.inputSchema,
    )

    expect(schema).toContain('ethereum')
    expect(schema).toContain('base')
    // 'all' is a tier-2 concern; tier-1 answers one chain per call
    expect(schema).not.toContain('"all"')
    await client.close()
  })

  it('rejects an unconfigured chain rather than guessing', async () => {
    const client = await connect(twoChains())
    const { isError, text } = await call(client, 'chainspeak_get_account', {
      address_or_name: VITALIK,
      chain: 'polygon',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/polygon|Invalid/)
    await client.close()
  })

  it('surfaces a chain failure as the call failing, with no partial-success shape', async () => {
    const client = await connect([
      { chain: base, reader: reader(8453n, { account: () => okAsync(null) }) },
    ])
    const { body } = await call(client, 'chainspeak_get_chain_status', {})
    expect(body.chain).toBe('base')
    expect(body.failed).toBeUndefined()
    await client.close()
  })
})

describe('chain-specific answers', () => {
  it('reports each chain native symbol rather than assuming ETH', async () => {
    const client = await connect([
      { chain: mainnet, reader: reader(1n) },
      { chain: polygon, reader: reader(137n) },
    ])

    const eth = await call(client, 'chainspeak_get_account', { address_or_name: VITALIK })
    const pol = await call(client, 'chainspeak_get_account', {
      address_or_name: VITALIK,
      chain: 'polygon',
    })

    expect(eth.body.native_symbol).toBe('ETH')
    expect(pol.body.native_symbol).toBe('POL')
    await client.close()
  })

  it('omits the transfer estimate on OP-stack chains when the L1 fee is unknown', async () => {
    const client = await connect(twoChains())

    const eth = await call(client, 'chainspeak_get_chain_status', {})
    const l2 = await call(client, 'chainspeak_get_chain_status', { chain: 'base' })

    expect(eth.body.simple_transfer_cost).not.toBeNull()
    expect(l2.body.simple_transfer_cost).toBeNull()
    expect(l2.body.gas_tiers).not.toBeNull()
    expect(String(l2.body.note)).toContain('L1 data fee')
    await client.close()
  })

  it('includes the L1 data fee in the estimate once it can be read', async () => {
    const client = await connect([
      { chain: base, reader: reader(8453n, { l1DataFee: () => okAsync(9_000_000_000_000n) }) },
    ])

    const { body } = await call(client, 'chainspeak_get_chain_status', {})
    const cost = body.simple_transfer_cost as {
      l1_breakdown: { l2_fee_wei: string; l1_data_fee_wei: string } | null
      fee_wei: string
    } | null

    // L2 portion is 21000 * (20 + 1.5) gwei; the L1 fee is added on top
    expect(cost?.l1_breakdown?.l2_fee_wei).toBe('451500000000000')
    expect(cost?.l1_breakdown?.l1_data_fee_wei).toBe('9000000000000')
    expect(cost?.fee_wei).toBe('460500000000000')
    expect(String(body.note)).toContain('includes it')
    await client.close()
  })
})
