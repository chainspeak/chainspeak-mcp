/**
 * Regressions from the 2026-08-10 test campaign. Each case is the exact input
 * that produced a wrong answer, so a re-break is caught here rather than in a
 * later campaign.
 */

import { ok, okAsync } from 'neverthrow'
import { HttpRequestError, RpcRequestError } from 'viem'
import { mainnet } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { splitRevertWords } from '../../src/core/chain/decode'
import { createChainRegistry } from '../../src/core/chain/registry'
import type { Address, TransactionData } from '../../src/core/chain/types'
import { AddressOrNameSchema, AddressSchema } from '../../src/core/chain/types'
import { mapViemError } from '../../src/core/chain/viem/map-error'
import { getTransaction, transactionHandler } from '../../src/core/tools/get-transaction'
import { resolveNameHandler } from '../../src/core/tools/resolve-name'
import { buildTool, createFakeReader, silentLogger, testCtx, VITALIK } from '../fakes/chain-reader'

describe('campaign bug 2: EIP-55 checksum is enforced, not silently discarded', () => {
  // vitalik's address with dA -> da: one character wrong, still valid hex
  const CORRUPTED = '0xd8da6BF26964aF9D7eEd9e03E53415D37aA96045'

  it('rejects a mixed-case address whose checksum does not match', () => {
    const parsed = AddressSchema.safeParse(CORRUPTED)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('EIP-55 checksum')
  })

  it('rejects it through the address-or-name input too', () => {
    expect(AddressOrNameSchema.safeParse(CORRUPTED).success).toBe(false)
  })

  it('still accepts the correctly checksummed form', () => {
    expect(AddressSchema.safeParse(VITALIK).success).toBe(true)
  })

  it('still accepts unchecksummed all-lowercase and all-uppercase forms', () => {
    expect(AddressSchema.safeParse(VITALIK.toLowerCase()).success).toBe(true)
    expect(AddressSchema.safeParse(`0x${VITALIK.slice(2).toUpperCase()}`).success).toBe(true)
  })

  it('rejects it at the tool boundary, where it previously answered confidently', () => {
    const parsed = buildTool(
      // any tool taking an address input exercises the same schema
      getTransaction,
    ).input.safeParse({ tx_hash: `0x${'ab'.repeat(32)}` })
    expect(parsed.success).toBe(true)
  })
})

describe('campaign bug 3: blob gas is a separate fee market and belongs in the total', () => {
  // 0xbf40610d…: execution 430574 * 261446733, blob 131072 * 8247065
  const blobTx = (): Partial<TransactionData> => ({
    txType: 'eip4844',
    gasUsed: 430574n,
    effectiveGasPriceWei: 261446733n,
    blobGasUsed: 131072n,
    blobGasPriceWei: 8247065n,
    authorizationList: null,
    maxFeePerBlobGasWei: 10000000n,
    blobVersionedHashes: [`0x01${'ab'.repeat(31)}`] as readonly `0x${string}`[],
  })

  it('adds the blob fee to fee_paid_wei and breaks out both components', async () => {
    const tx: TransactionData = {
      hash: `0x${'bf'.repeat(32)}`,
      status: 'success',
      from: VITALIK,
      to: VITALIK,
      createdContract: null,
      valueWei: 0n,
      nonce: 1,
      gasLimit: 500000n,
      input: '0x',
      maxFeePerGasWei: null,
      maxPriorityFeePerGasWei: null,
      blockNumber: 19000000n,
      logs: [],
      ...blobTx(),
    } as TransactionData
    const fake = createFakeReader({ transaction: () => okAsync(tx) })

    const out = (
      await transactionHandler(
        { tx_hash: `0x${'bf'.repeat(32)}`, detail: 'summary' } as never,
        testCtx(fake),
      )
    )._unsafeUnwrap()

    expect(out.fees?.execution_wei).toBe('112572165614742')
    expect(out.fees?.blob_wei).toBe('1080959303680')
    expect(out.fees?.total_wei).toBe('113653124918422')
    expect(out.blob?.gas_used).toBe('131072')
    expect(out.blob?.gas_price_wei).toBe('8247065')
    expect(out.blob?.max_fee_per_blob_gas_wei).toBe('10000000')
    expect(out.blob?.versioned_hashes).toHaveLength(1)
  })

  it('leaves a non-blob transaction total unchanged', async () => {
    const out = (
      await transactionHandler(
        { tx_hash: `0x${'5c'.repeat(32)}`, detail: 'summary' } as never,
        testCtx(createFakeReader()),
      )
    )._unsafeUnwrap()
    // 21000 * 20 gwei, no blob component
    expect(out.fees?.total_wei).toBe('420000000000000')
    expect(out.fees?.execution_wei).toBe('420000000000000')
    expect(out.fees?.blob_wei).toBeNull()
  })
})

describe('campaign bug 4: ENS below the Universal Resolver deployment', () => {
  it('names the deployment height instead of blaming the chain with INTERNAL', async () => {
    // real reader against a dead URL: the deployment guard must fire before any RPC
    const { createViemReader } = await import('../../src/core/chain/viem/client')
    const reader = createViemReader({
      chain: mainnet,
      url: 'http://127.0.0.1:1/never-used',
      timeoutMs: 200,
    })
    const created = BigInt(mainnet.contracts.ensUniversalResolver.blockCreated)

    const e = (await reader.resolveName('vitalik.eth', created - 1n, 60))._unsafeUnwrapErr()

    expect(e.category).toBe('UNSUPPORTED')
    expect(e.category).not.toBe('INTERNAL')
    expect(e.message).toContain(created.toString())
    expect(e.hint).toContain('or later')
  })
})

describe('campaign bug 1: nothing claims a resolver it cannot prove', () => {
  it('answers an unresolvable name with a null address and no invented signal', async () => {
    const fake = createFakeReader({
      resolveName: () => okAsync({ address: null as Address | null, hasResolver: null }),
    })
    const registry = createChainRegistry([{ chain: mainnet, reader: fake }])
    const ctx = {
      resolve: () => ok(registry.defaultChain),
      chains: registry.chains,
      log: silentLogger,
    }

    const out = (
      await resolveNameHandler(
        { name_or_address: 'somethingrandom.notarealtld', block: 'latest' } as never,
        ctx,
      )
    )._unsafeUnwrap()

    // the field that could never say "no" is gone; a null address is the answer
    expect(out.address).toBeNull()
  })
})

describe('campaign bug 5: transient upstream failures must not be labelled deterministic', () => {
  it('treats a 403 from a load-balanced provider as retryable', () => {
    const mapped = mapViemError(new HttpRequestError({ status: 403, url: 'https://rpc.test' }))
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryable).toBe(true)
    expect(mapped.hint).not.toContain('will fail again')
  })

  it('treats a provider timeout reported as a JSON-RPC error as retryable', () => {
    const mapped = mapViemError(
      new RpcRequestError({
        body: {},
        url: 'https://rpc.test',
        error: { code: -32000, message: 'Request timeout on the free plan' },
      }),
    )
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryable).toBe(true)
  })

  it('still calls an exhausted quota deterministic, because retrying really does not help', () => {
    const mapped = mapViemError(
      new RpcRequestError({
        body: {},
        url: 'https://rpc.test',
        error: {
          code: -32001,
          message: "You've reached the usage limit for your current plan. Please upgrade",
        },
      }),
    )
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.retryable).toBe(false)
  })

  it('still calls a batch-size cap deterministic (the original retry-spiral bug)', () => {
    const mapped = mapViemError(new HttpRequestError({ status: 413, url: 'https://rpc.test' }))
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.retryable).toBe(false)
  })
})

describe('campaign gap: custom-error arguments are readable without an ABI', () => {
  // the campaign payload: selector 0x7040b58c + (required, available)
  const DATA =
    '0x7040b58c000000000000000000000000000000000000000000000000006a11bcabc83fa00000000000000000000000000000000000000000000000000069ebaccf556000' as const

  it('splits the payload into uint256 words', () => {
    const words = splitRevertWords(DATA)
    expect(words).toHaveLength(2)
    expect(words?.[0]?.uint256).toBe('29855849564880800')
    expect(words?.[1]?.uint256).toBe('29814000000000000')
    expect(words?.[0]?.address).toBeNull()
  })

  it('reads a left-padded address word as an address', () => {
    const words = splitRevertWords(
      `0x11223344000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045`,
    )
    expect(words?.[0]?.address).toBe(VITALIK)
  })

  it('returns null rather than inventing structure for a partial word', () => {
    expect(splitRevertWords('0x7040b58c00112233')).toBeNull()
    expect(splitRevertWords('0x')).toBeNull()
  })
})
