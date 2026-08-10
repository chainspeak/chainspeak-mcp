import type { ChainRegistry } from '../chain/registry'
import type { Tool, ToolFactory } from '../mcp/define-tool'
import { getAccount } from './get-account'
import { getBlock } from './get-block'
import { getChainStatus } from './get-chain-status'
import { getEvents } from './get-events'
import { getToken } from './get-token'
import { getTransaction } from './get-transaction'
import { resolveName } from './resolve-name'

export const allTools: readonly ToolFactory[] = [
  getChainStatus,
  getAccount,
  getToken,
  getTransaction,
  getBlock,
  getEvents,
  resolveName,
] as const

/** Build the tier-1 tool set for the chains a server is configured for. */
export const createTools = (registry: ChainRegistry): readonly Tool[] =>
  allTools.map((factory) => factory(registry))
