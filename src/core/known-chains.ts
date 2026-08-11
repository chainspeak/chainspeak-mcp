/**
 * The chains the bundled server can be pointed at via the CHAIN env var.
 * Library consumers never go through this — they pass their own viem `Chain`
 * to createChainRegistry, so any of viem's 700+ chains works.
 */

import type { Chain } from 'viem'
import {
  arbitrum,
  base,
  bsc,
  gnosis,
  holesky,
  linea,
  mainnet,
  optimism,
  polygon,
  sepolia,
} from 'viem/chains'
import { chainKey, normalizeChainKey, shortAlias } from './chain/registry'

export const KNOWN_CHAINS: readonly Chain[] = [
  mainnet,
  base,
  optimism,
  arbitrum,
  polygon,
  bsc,
  gnosis,
  linea,
  sepolia,
  holesky,
]

/** Accepts the derived key ('op-mainnet'), a short alias ('op'), or a chain id. */
export const findKnownChain = (selector: string): Chain | undefined => {
  const wanted = normalizeChainKey(selector)
  return (
    KNOWN_CHAINS.find((chain) => chainKey(chain) === wanted) ??
    KNOWN_CHAINS.find((chain) => chain.id.toString() === wanted) ??
    KNOWN_CHAINS.find((chain) => shortAlias(chainKey(chain)) === wanted)
  )
}

export const knownChainNames = (): string => KNOWN_CHAINS.map(chainKey).join(', ')
