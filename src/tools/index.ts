import type { Tool } from '../mcp/define-tool'
import { getBalance } from './get-balance'
import { getChainInfo } from './get-chain-info'
import { getTokenBalance } from './get-token-balance'

export const allTools: readonly Tool[] = [getChainInfo, getBalance, getTokenBalance] as const
