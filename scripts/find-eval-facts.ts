/** One-off: pull deterministic ground-truth facts for new eval tasks from mainnet. */
import { decodeTokenEvents } from '../src/core/chain/decode'
import { createViemReader } from '../src/core/chain/viem/client'
import type { Hash } from '../src/core/chain/types'

const reader = createViemReader({ url: 'https://eth.drpc.org', timeoutMs: 20000 })

const block = (await reader.block(19000000n, { fullTxs: false }))._unsafeUnwrap()
if (!block) throw new Error('no block')
console.log('tx_count:', block.txCount)
console.log('gas_used_percent:', (Number((block.gasUsed * 10000n) / block.gasLimit) / 100).toFixed(2))
console.log('last tx hash:', block.txHashes[block.txHashes.length - 1])

// find a tx in this block with exactly one decoded ERC-20 transfer
for (const hash of block.txHashes.slice(0, 40)) {
  const tx = (await reader.transaction(hash as Hash))._unsafeUnwrap()
  if (!tx || tx.logs === null) continue
  const events = decodeTokenEvents(tx.logs)
  const erc20 = events.filter((e) => e.standard === 'erc20' && e.event === 'transfer')
  if (erc20.length === 1 && events.length === 1) {
    console.log('clean erc20-transfer tx:', hash)
    console.log('  token:', erc20[0].token, 'from:', erc20[0].from, 'to:', erc20[0].to)
    console.log('  amount_raw:', erc20[0].amount_raw)
    break
  }
}
process.exit(0)
