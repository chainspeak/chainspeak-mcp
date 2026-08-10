/**
 * Live smoke of the six tier-1 tools against a real RPC endpoint.
 * Run: pnpm tsx scripts/live-smoke.ts   (ETH_RPC_URL overrides the default)
 */
import { ok } from 'neverthrow'
import pino from 'pino'
import { createViemReader } from '../src/core/chain/viem/client'
import { accountHandler, getAccount } from '../src/core/tools/get-account'
import { blockHandler, getBlock } from '../src/core/tools/get-block'
import { chainStatusHandler, getChainStatus } from '../src/core/tools/get-chain-status'
import { getToken, tokenHandler } from '../src/core/tools/get-token'
import { getTransaction, transactionHandler } from '../src/core/tools/get-transaction'
import { resolveName, resolveNameHandler } from '../src/core/tools/resolve-name'

const url = process.env['ETH_RPC_URL'] ?? 'https://eth.drpc.org'
const reader = createViemReader({ url, timeoutMs: 20000 })
const ctx = { readerFor: () => ok(reader), log: pino({ level: 'silent' }) }

const show = (
  label: string,
  r: { isOk(): boolean; _unsafeUnwrap(): unknown; _unsafeUnwrapErr(): unknown },
): void => {
  const value = r.isOk() ? r._unsafeUnwrap() : { ERR: r._unsafeUnwrapErr() }
  process.stderr.write(`\n=== ${label} ===\n${JSON.stringify(value, null, 1).slice(0, 1600)}\n`)
}

const FIRST_TX = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060'

show('chain_status latest', await chainStatusHandler(getChainStatus.input.parse({}) as never, ctx))
show(
  'chain_status historical',
  await chainStatusHandler(getChainStatus.input.parse({ block: '15000000' }) as never, ctx),
)
show(
  'account vitalik.eth @ 0x121eac0 (hex block)',
  await accountHandler(
    getAccount.input.parse({ address_or_name: 'vitalik.eth', block: '0x121eac0' }) as never,
    ctx,
  ),
)
show(
  'resolve reverse vitalik',
  await resolveNameHandler(
    resolveName.input.parse({
      name_or_address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    }) as never,
    ctx,
  ),
)
show('block 19000000', await blockHandler(getBlock.input.parse({ block: '19000000' }) as never, ctx))
show(
  'block full_txs limit 2',
  await blockHandler(
    getBlock.input.parse({ block: '19000000', detail: 'full_txs', limit: 2 }) as never,
    ctx,
  ),
)
show(
  'tx first-ever (legacy)',
  await transactionHandler(getTransaction.input.parse({ tx_hash: FIRST_TX }) as never, ctx),
)
show(
  'token USDC holderless',
  await tokenHandler(
    getToken.input.parse({ token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }) as never,
    ctx,
  ),
)
show(
  'token USDC vitalik.eth @ 19000000',
  await tokenHandler(
    getToken.input.parse({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      holder: 'vitalik.eth',
      block: '19000000',
    }) as never,
    ctx,
  ),
)

process.exit(0)
