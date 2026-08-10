import { errAsync, okAsync } from 'neverthrow'
import { toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { upstreamTransient } from '../../src/core/chain/errors'
import type { Address, TransactionData } from '../../src/core/chain/types'
import { getTransaction, transactionHandler } from '../../src/core/tools/get-transaction'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'

const HASH = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

const parse = (raw: Record<string, unknown>) =>
  buildTool(getTransaction).input.parse(raw) as Parameters<typeof transactionHandler>[0]

const baseTx = (overrides?: Partial<TransactionData>): TransactionData => ({
  hash: HASH,
  status: 'success',
  from: VITALIK,
  to: '0x28C6c06298d514Db089934071355E5743bf21d60' as Address,
  createdContract: null,
  valueWei: 1500000000000000000n,
  nonce: 5,
  txType: 'eip1559',
  authorizationList: null,
  maxFeePerBlobGasWei: null,
  blobVersionedHashes: null,
  blobGasUsed: null,
  blobGasPriceWei: null,
  gasLimit: 21000n,
  input: '0x',
  maxFeePerGasWei: 30000000000n,
  maxPriorityFeePerGasWei: 1000000000n,
  blockNumber: 19000000n,
  gasUsed: 21000n,
  effectiveGasPriceWei: 20000000000n,
  logs: [],
  ...overrides,
})

describe('chainspeak_get_transaction', () => {
  it('summarizes a transaction with gas_limit, fee math, confirmations, and context echo', async () => {
    const fake = createFakeReader()
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out).toMatchObject({
      chain_id: '1',
      chain_head: '19000000',
      found: true,
      status: 'success',
      from: VITALIK,
      gas_limit: '21000',
      receipt: {
        gas_used: '21000',
        gas_used_percent: '100.00',
        included_in_block: '19000000',
        confirmations: '1',
      },
      fees: {
        total_wei: '420000000000000',
        total_native: '0.00042',
        max_fee_per_gas_wei: '30000000000',
        max_priority_fee_per_gas_wei: '1000000000',
      },
      nonce: 5,
      tx_type: 'eip1559',
      method: null,
      token_transfers: [],
      logs: null,
      raw_transaction: null,
      note: null,
    })
  })

  it('computes gas_used_percent that exposes out-of-gas failures', async () => {
    const fake = createFakeReader({
      transaction: () => okAsync(baseTx({ status: 'failed', gasLimit: 100000n, gasUsed: 100000n })),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().receipt?.gas_used_percent).toBe('100.00')
    expect(result._unsafeUnwrap().status).toBe('failed')
  })

  it('attaches a failure analysis to a failed transaction', async () => {
    const fake = createFakeReader({
      transaction: () => okAsync(baseTx({ status: 'failed' })),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().failure).toEqual({
      reason: 'reverted with reason: "ERC20: transfer amount exceeds balance"',
      revert_data: '0x08c379a0',
      revert_data_words: null,
      method: 'replay',
      confidence: 'approximate',
      method_note: null,
    })
  })

  it('surfaces a method_note when the ladder degraded below the probed capability', async () => {
    const fake = createFakeReader({
      transaction: () => okAsync(baseTx({ status: 'failed' })),
      analyzeFailure: () =>
        okAsync({
          reason: 'reverted with custom error 0x7040b58c',
          revertData: '0x7040b58c' as const,
          method: 'replay' as const,
          confidence: 'approximate' as const,
          note: 'trace attempted but failed (UPSTREAM_TRANSIENT: rate limited) — replay used; retrying the tool call may reach the trace path',
        }),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().failure?.method_note).toContain('trace attempted but failed')
  })

  it('leaves failure null on a successful transaction (analysis is not even attempted)', async () => {
    let analyzed = 0
    const fake = createFakeReader({
      analyzeFailure: () => {
        analyzed += 1
        return okAsync({
          reason: null,
          revertData: null,
          method: 'none' as const,
          confidence: 'none' as const,
          note: null,
        })
      },
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().failure).toBeNull()
    expect(analyzed).toBe(0)
  })

  it('decodes the calldata selector for a bundled method', async () => {
    const fake = createFakeReader({
      transaction: () => okAsync(baseTx({ input: `0xa9059cbb${'0'.repeat(128)}` })),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().method).toEqual({ selector: '0xa9059cbb', name: 'transfer' })
  })

  it('decodes an ERC-20 Transfer event into token_transfers', async () => {
    const topic = toEventSelector('Transfer(address,address,uint256)')
    const pad = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as const
    const fake = createFakeReader({
      transaction: () =>
        okAsync(
          baseTx({
            logs: [
              {
                address: USDC,
                topics: [topic, pad(VITALIK), pad('0x28C6c06298d514Db089934071355E5743bf21d60')],
                data: `0x${'0'.repeat(56)}3b9aca00`,
                logIndex: 0,
              },
            ],
          }),
        ),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().token_transfers).toEqual([
      {
        standard: 'erc20',
        token: USDC,
        from: VITALIK,
        to: '0x28C6c06298d514Db089934071355E5743bf21d60',
        amount_raw: '1000000000',
        amount_formatted: '1000',
        symbol: 'USDC',
        decimals: 6,
        token_id: null,
        log_index: 0,
      },
    ])
  })

  it('includes raw logs only at detail full', async () => {
    const topic = toEventSelector('Transfer(address,address,uint256)')
    const log = {
      address: USDC,
      topics: [topic],
      data: '0x' as const,
      logIndex: 3,
    }
    const fake = createFakeReader({ transaction: () => okAsync(baseTx({ logs: [log] })) })

    const summary = await transactionHandler(parse({ tx_hash: HASH }), testCtx(fake))
    const full = await transactionHandler(parse({ tx_hash: HASH, detail: 'full' }), testCtx(fake))

    expect(summary._unsafeUnwrap().logs).toBeNull()
    expect(full._unsafeUnwrap().logs).toEqual([
      { address: USDC, topics: [topic], data: '0x', log_index: 3 },
    ])
  })

  it('attaches untouched RPC payloads at detail raw', async () => {
    const fake = createFakeReader()
    const args = parse({ tx_hash: HASH, detail: 'raw' })

    const result = await transactionHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.raw_transaction).toEqual({ hash: HASH })
    expect(out.raw_receipt).toEqual({ status: '0x1' })
  })

  it('leaves receipt fields null for a pending transaction', async () => {
    const fake = createFakeReader({
      transaction: () =>
        okAsync(
          baseTx({
            status: 'pending',
            blockNumber: null,
            gasUsed: null,
            effectiveGasPriceWei: null,
            logs: null,
          }),
        ),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.status).toBe('pending')
    // a pending transaction has no receipt at all, rather than a receipt of nulls
    expect(out.receipt).toBeNull()
    expect(out.fees).toBeNull()
    expect(out.gas_limit).toBe('21000')
  })

  it('answers an unknown hash with found false, a note, and context echoed', async () => {
    const fake = createFakeReader({ transaction: () => okAsync(null) })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.found).toBe(false)
    expect(out.note).toMatch(/not found/)
    expect(out.chain_id).toBe('1')
    expect(out.chain_head).toBe('19000000')
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      transaction: () => errAsync(upstreamTransient('connection refused', 'check the endpoint')),
    })
    const args = parse({ tx_hash: HASH })

    const result = await transactionHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_TRANSIENT')
  })
})
