/** Chain metadata is derived from viem so it cannot drift out of date. */

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from 'neverthrow'
import type { Chain } from 'viem'
import { type ChainError, invalidInput } from './errors'
import type { ChainReader } from './reader'

/**
 * The FIRST window a log scan tries, not a cap. Nothing refuses a range for
 * exceeding it: `scanLogs` starts here and corrects downward when the provider
 * actually refuses, because a hardcoded cap was wrong in both directions —
 * larger than what drpc would accept, and far smaller than what an L2 question
 * needs.
 */
export const DEFAULT_MAX_LOG_RANGE = 10_000n

/** Properties of the CHAIN. Properties of the ENDPOINT are probed instead — see probe.ts. */
export interface ChainFeatures {
  /** the chain has an ENS Universal Resolver deployment of its own */
  ens: boolean
  /** OP-stack: an L1 data fee applies on top of L2 gas, and dominates it */
  l1DataFee: boolean
  multicall3: boolean
  testnet: boolean
}

export interface ChainEntry {
  chain: Chain
  reader: ChainReader
  /** first getLogs window to try; adapts downward on refusal. Defaults to DEFAULT_MAX_LOG_RANGE */
  maxLogRange?: bigint
  /** nominal seconds per block, used to describe ranges in time to the agent */
  blockTimeSec?: number
}

export interface ResolvedChain {
  /** derived from viem's chain name: 'ethereum', 'op-mainnet' */
  key: string
  chain: Chain
  chainId: bigint
  label: string
  native: { symbol: string; decimals: number }
  /** ENSIP-11 coin type; null for chain ids outside the 31-bit scheme */
  coinType: number | null
  features: ChainFeatures
  maxLogRange: bigint
  blockTimeSec: number | null
}

export interface ChainHandle {
  spec: ResolvedChain
  reader: ChainReader
}

export interface ChainRegistry {
  chains: readonly ChainHandle[]
  defaultChain: ChainHandle
  /** where ENS names are resolved; null when no configured chain has ENS */
  ensHome: ChainHandle | null
  /** Resolve by key, alias, or chain id; undefined selects the default. */
  resolve(selector?: string): Result<ChainHandle, ChainError>
}

export const normalizeChainKey = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const chainKey = (chain: Chain): string => normalizeChainKey(chain.name)

/** ENSIP-11 coin type for an EVM chain; mainnet keeps its legacy SLIP-44 value. */
export const coinTypeFor = (chainId: number): number | null => {
  if (chainId === 1) return 60
  if (chainId > 0x7fff_ffff || chainId < 0) return null
  return (0x8000_0000 | chainId) >>> 0
}

const featuresOf = (chain: Chain): ChainFeatures => ({
  ens: chain.contracts?.ensUniversalResolver !== undefined,
  // gasPriceOracle is an OP-stack predeploy, outside viem's typed contract keys
  l1DataFee: chain.contracts?.['gasPriceOracle'] !== undefined,
  multicall3: chain.contracts?.multicall3 !== undefined,
  testnet: chain.testnet === true,
})

const specFor = (entry: ChainEntry): ResolvedChain => ({
  key: chainKey(entry.chain),
  chain: entry.chain,
  chainId: BigInt(entry.chain.id),
  label: entry.chain.name,
  native: {
    symbol: entry.chain.nativeCurrency.symbol,
    decimals: entry.chain.nativeCurrency.decimals,
  },
  coinType: coinTypeFor(entry.chain.id),
  features: featuresOf(entry.chain),
  maxLogRange: entry.maxLogRange ?? DEFAULT_MAX_LOG_RANGE,
  blockTimeSec: entry.blockTimeSec ?? null,
})

/** First word of a key ('op-mainnet' -> 'op'), registered only when unambiguous. */
export const shortAlias = (key: string): string | null => {
  const head = key.split('-')[0]
  return head === undefined || head === key || head === '' ? null : head
}

export const createChainRegistry = (
  entries: readonly ChainEntry[],
  opts: { default?: string } = {},
): ChainRegistry => {
  if (entries.length === 0) {
    throw new Error('createChainRegistry: at least one chain is required')
  }
  const handles: readonly ChainHandle[] = entries.map((entry) => ({
    spec: specFor(entry),
    reader: entry.reader,
  }))

  const byKey = new Map<string, ChainHandle>()
  for (const handle of handles) {
    if (byKey.has(handle.spec.key)) {
      throw new Error(`createChainRegistry: duplicate chain '${handle.spec.key}'`)
    }
    byKey.set(handle.spec.key, handle)
  }
  for (const handle of handles) byKey.set(handle.spec.chainId.toString(), handle)

  const aliasCounts = new Map<string, number>()
  for (const handle of handles) {
    const alias = shortAlias(handle.spec.key)
    if (alias !== null) aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1)
  }
  for (const handle of handles) {
    const alias = shortAlias(handle.spec.key)
    if (alias !== null && aliasCounts.get(alias) === 1 && !byKey.has(alias)) {
      byKey.set(alias, handle)
    }
  }

  const first = handles[0] as ChainHandle
  const defaultChain =
    opts.default === undefined ? first : byKey.get(normalizeChainKey(opts.default))
  if (defaultChain === undefined) {
    throw new Error(`createChainRegistry: default chain '${opts.default}' is not registered`)
  }

  const names = handles.map((h) => h.spec.key).join(', ')
  const resolve = (selector?: string): Result<ChainHandle, ChainError> => {
    if (selector === undefined) return ok(defaultChain)
    const hit = byKey.get(normalizeChainKey(selector))
    if (hit !== undefined) return ok(hit)
    return err(
      invalidInput(
        `unknown chain '${selector}'`,
        `this server is configured for: ${names} — pass one of those names or its chain id, or omit the chain parameter to use ${defaultChain.spec.key}`,
      ),
    )
  }

  return {
    chains: handles,
    defaultChain,
    ensHome: handles.find((h) => h.spec.features.ens) ?? null,
    resolve,
  }
}

/**
 * Assert every endpoint really serves the chain it is registered as. A Base URL
 * registered as ethereum would otherwise answer everything confidently and wrongly.
 */
export const verifyChains = (registry: ChainRegistry): ResultAsync<void, ChainError> =>
  ResultAsync.combine(
    registry.chains.map((handle) =>
      handle.reader
        .chainId()
        .andThen((live) =>
          live === handle.spec.chainId
            ? okAsync(undefined)
            : errAsync(
                invalidInput(
                  `chain '${handle.spec.key}' is registered as chain id ${handle.spec.chainId} but its RPC endpoint reports ${live}`,
                  `point that endpoint at ${handle.spec.label}, or register the chain the endpoint actually serves`,
                ),
              ),
        ),
    ),
  ).map(() => undefined)
