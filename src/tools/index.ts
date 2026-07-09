import type { Tool } from '../mcp/define-tool'
import { getBalance } from './get-balance'
import { getChainInfo } from './get-chain-info'
import { getGasPrice } from './get-gas-price'
import { getTokenBalance } from './get-token-balance'
import { getTransaction } from './get-transaction'
import { resolveEns } from './resolve-ens'

export const allTools: readonly Tool[] = [
  getChainInfo,
  getBalance,
  getTokenBalance,
  getTransaction,
  resolveEns,
  getGasPrice,
] as const
