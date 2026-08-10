/**
 * Public library surface. Everything exported here is a contract.
 *
 *   const registry = createChainRegistry([
 *     { chain: mainnet, reader: createViemReader({ chain: mainnet, url: ETH_RPC, timeoutMs: 10_000 }) },
 *   ])
 *   await verifyChains(registry)
 *   const ctx = { resolve: registry.resolve, chains: registry.chains, log }
 *   for (const tool of createTools(registry)) tool.register(server, ctx)
 */

// ---- error taxonomy --------------------------------------------------------
export {
  type ChainError,
  contractCallFailed,
  type ErrorCategory,
  internal,
  invalidInput,
  isContractCallFailure,
  notFound,
  unsupported,
  upstreamPolicy,
  upstreamTransient,
  wrapChainError,
} from './core/chain/errors'
// ---- output formatting -----------------------------------------------------
export { scaleUnits, weiToDual, weiToGwei } from './core/chain/format'
// ---- upstream capability probe ---------------------------------------------
export { probeUpstream, type UpstreamCapabilities } from './core/chain/probe'
// ---- the chain port --------------------------------------------------------
export type { ChainReader } from './core/chain/reader'
// ---- the chain registry ----------------------------------------------------
export {
  type ChainEntry,
  type ChainFeatures,
  type ChainHandle,
  type ChainRegistry,
  chainKey,
  coinTypeFor,
  createChainRegistry,
  DEFAULT_MAX_LOG_RANGE,
  type ResolvedChain,
  verifyChains,
} from './core/chain/registry'
// ---- domain types ----------------------------------------------------------
export type {
  AccountState,
  Address,
  BlockData,
  BlockRef,
  BlockTag,
  BlockTx,
  FailureAnalysis,
  GasOutlook,
  Hash,
  LogEntry,
  LogFilter,
  NameResolution,
  PinnedBlock,
  RangeLog,
  TokenInfo,
  TransactionData,
  TxStatus,
} from './core/chain/types'
// ---- input schemas ---------------------------------------------------------
export {
  AddressOrNameSchema,
  AddressSchema,
  BLOCK_TAGS,
  BlockRefSchema,
  HashSchema,
  isAddressInput,
} from './core/chain/types'
// ---- tier-1 reader implementation ------------------------------------------
export { createViemReader } from './core/chain/viem/client'
export { mapViemError } from './core/chain/viem/map-error'
// ---- tool plumbing ---------------------------------------------------------
export {
  defineTool,
  type Tool,
  type ToolArgs,
  type ToolCtx,
  type ToolDef,
  type ToolFactory,
} from './core/mcp/define-tool'
// ---- cross-chain ENS -------------------------------------------------------
export {
  ensHomeFor,
  type NameProvenance,
  type ResolvedInput,
  resolveAddressInput,
  verifiedPrimaryName,
} from './core/mcp/ens'
// ---- tools -----------------------------------------------------------------
export { getAccount } from './core/tools/get-account'
export { getBlock } from './core/tools/get-block'
export { getChainStatus } from './core/tools/get-chain-status'
export { getEvents } from './core/tools/get-events'
export { getToken } from './core/tools/get-token'
export { getTransaction } from './core/tools/get-transaction'
export { allTools, createTools } from './core/tools/index'
export { resolveName } from './core/tools/resolve-name'
