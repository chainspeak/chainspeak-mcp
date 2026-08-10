import * as z from 'zod'
import { type ChainRegistry, normalizeChainKey } from '../chain/registry'

/** Enumerated in the schema so the agent picks a valid chain instead of guessing. */
export const chainField = (registry: ChainRegistry): z.ZodType => {
  const keys = registry.chains.map((c) => c.spec.key)
  const ids = registry.chains.map((c) => c.spec.chainId.toString())
  const fallback = registry.defaultChain.spec.key
  const values: [string, ...string[]] = [fallback, ...keys, ...ids]
  // an agent reads chain_name ("OP Mainnet") from a response and hands it back,
  // so normalise before matching rather than rejecting our own output
  return z
    .preprocess((v) => (typeof v === 'string' ? normalizeChainKey(v) : v), z.enum(values))
    .default(fallback)
    .describe(
      `which chain to read: ${keys.join(' | ')} (chain ids also work); default ${fallback}. One call answers for ONE chain — to compare chains, call once per chain.`,
    )
}
