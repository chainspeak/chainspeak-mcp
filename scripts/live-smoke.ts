import { createViemReader } from '../src/chain/viem/client'
import type { Address } from '../src/chain/types'

const url = process.env['ETH_RPC_URL'] ?? 'https://eth.llamarpc.com'
const reader = createViemReader({ url, timeoutMs: 15000 })

const vitalik: Address = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const usdc: Address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const binance: Address = '0x28c6c06298d514db089934071355e5743bf21d60'
const notAContract: Address = '0x0000000000000000000000000000000000000001'

const show = (label: string, value: unknown) =>
  process.stderr.write(`${label}: ${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`)

const info = await reader.chainInfo()
show('chainInfo', info.match((v) => v, (e) => ({ ERR: e })))

const bal = await reader.balance(vitalik, 'latest')
show('balance(vitalik)', bal.match((v) => v, (e) => ({ ERR: e })))

const token = await reader.tokenBalance(usdc, binance)
show('tokenBalance(USDC, binance)', token.match((v) => v, (e) => ({ ERR: e })))

const bad = await reader.tokenBalance(notAContract, vitalik)
show('tokenBalance(not-a-contract) — expect invalid_input', bad.match((v) => v, (e) => ({ ERR: e })))

const firstTx = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' as const
const tx = await reader.transaction(firstTx)
show('transaction(first mainnet tx)', tx.match((v) => v, (e) => ({ ERR: e })))

const missing = await reader.transaction(`0x${'de'.repeat(32)}`)
show('transaction(garbage hash) — expect null', missing.match((v) => v, (e) => ({ ERR: e })))

const ens = await reader.resolveEns('vitalik.eth')
show('resolveEns(vitalik.eth)', ens.match((v) => v, (e) => ({ ERR: e })))

const noEns = await reader.resolveEns('this-name-does-not-exist-40404.eth')
show('resolveEns(unregistered) — expect null', noEns.match((v) => v, (e) => ({ ERR: e })))

const fees = await reader.feeEstimate()
show('feeEstimate', fees.match((v) => v, (e) => ({ ERR: e })))

process.exit(0)
