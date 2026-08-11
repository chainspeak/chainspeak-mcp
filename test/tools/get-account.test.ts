import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import { upstreamTransient } from '../../src/core/chain/errors'
import type { Address } from '../../src/core/chain/types'
import { accountHandler, getAccount } from '../../src/core/tools/get-account'
import { buildTool, createFakeReader, testCtx, VITALIK } from '../fakes/chain-reader'

const parse = (raw: Record<string, unknown>) =>
  buildTool(getAccount).input.parse(raw) as Parameters<typeof accountHandler>[0]

describe('chainspeak_get_account', () => {
  it('returns full account state with chain_id and block_number echoed', async () => {
    const fake = createFakeReader()
    const args = parse({ address_or_name: VITALIK })

    const result = await accountHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap()).toEqual({
      chain_id: '1',
      block_number: '19000000',
      address: VITALIK,
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

  it('reports an EIP-7702 delegation without calling the account a contract', async () => {
    const DELEGATE = '0x28C6c06298d514Db089934071355E5743bf21d60' as Address
    const fake = createFakeReader({
      account: () =>
        okAsync({ balanceWei: 1n, nonce: 7, isContract: false, delegatedTo: DELEGATE }),
    })
    const args = parse({ address_or_name: VITALIK })

    const result = await accountHandler(args, testCtx(fake))

    const out = result._unsafeUnwrap()
    expect(out.is_contract).toBe(false)
    expect(out.delegated_to).toBe(DELEGATE)
  })

  it('returns the address EIP-55 checksummed even for lowercase input', async () => {
    const fake = createFakeReader()
    const args = parse({ address_or_name: VITALIK.toLowerCase() })

    const result = await accountHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().address).toBe(VITALIK)
  })

  it('resolves an ENS name at the pinned block and echoes it in resolved_from', async () => {
    const pinned: bigint[] = []
    const fake = createFakeReader({
      resolveName: (_name, atBlock) => {
        pinned.push(atBlock)
        return okAsync({ address: VITALIK, hasResolver: true })
      },
    })
    const args = parse({ address_or_name: 'vitalik.eth' })

    const result = await accountHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().resolution?.name).toBe('vitalik.eth')
    expect(result._unsafeUnwrap().address).toBe(VITALIK)
    expect(pinned).toEqual([19000000n])
  })

  it('reads account state at the SAME pinned block the name was resolved at', async () => {
    const blocks: bigint[] = []
    const fake = createFakeReader({
      pinBlock: () => okAsync({ number: 15000000n, timestamp: 1n }),
      resolveName: (_n, atBlock) => {
        blocks.push(atBlock)
        return okAsync({ address: VITALIK, hasResolver: true })
      },
      account: (_a, atBlock) => {
        blocks.push(atBlock)
        return okAsync({ balanceWei: 1n, nonce: 0, isContract: false, delegatedTo: null })
      },
    })
    const args = parse({ address_or_name: 'vitalik.eth', block: '15000000' })

    await accountHandler(args, testCtx(fake))

    expect(blocks).toEqual([15000000n, 15000000n])
  })

  it('answers an unresolvable name with NOT_FOUND and a steering hint', async () => {
    const fake = createFakeReader({
      resolveName: () => okAsync({ address: null, hasResolver: false }),
    })
    const args = parse({ address_or_name: 'nobody-owns-this-name-000.eth' })

    const result = await accountHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    const e = result._unsafeUnwrapErr()
    expect(e.category).toBe('NOT_FOUND')
    expect(e.retryable).toBe(false)
    expect(e.hint).toContain('chainspeak_resolve_name')
  })

  it('reports a forward-verified reverse ENS name', async () => {
    const fake = createFakeReader({
      reverseName: () => okAsync('vitalik.eth'),
      resolveName: () => okAsync({ address: VITALIK, hasResolver: true }),
    })
    const args = parse({ address_or_name: VITALIK })

    const result = await accountHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().ens_name).toBe('vitalik.eth')
  })

  it('suppresses a reverse ENS name that does not forward-resolve back (spoof guard)', async () => {
    const OTHER = '0x28C6c06298d514Db089934071355E5743bf21d60' as Address
    const fake = createFakeReader({
      reverseName: () => okAsync('impostor.eth'),
      resolveName: () => okAsync({ address: OTHER, hasResolver: true }),
    })
    const args = parse({ address_or_name: VITALIK })

    const result = await accountHandler(args, testCtx(fake))

    expect(result._unsafeUnwrap().ens_name).toBeNull()
  })

  it('accepts hex block numbers (the form explorers show)', () => {
    const args = parse({ address_or_name: VITALIK, block: '0x121eac0' })
    expect(args.block).toBe(19000000n)
  })

  it('defaults block to latest when omitted', () => {
    const args = parse({ address_or_name: VITALIK })
    expect(args.block).toBe('latest')
  })

  it('rejects a malformed 0x input with a corrective message', () => {
    const parsed = buildTool(getAccount).input.safeParse({ address_or_name: '0xd8da6b' })
    expect(parsed.success).toBe(false)
    const message = parsed.error?.issues[0]?.message ?? ''
    expect(message).toMatch(/42-character/)
  })

  it('propagates a reader error unchanged', async () => {
    const fake = createFakeReader({
      account: () => errAsync(upstreamTransient('slow down', 'wait a moment', 1000)),
    })
    const args = parse({ address_or_name: VITALIK })

    const result = await accountHandler(args, testCtx(fake))

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().category).toBe('UPSTREAM_TRANSIENT')
  })
})
