import type { ResultAsync } from 'neverthrow'
import type { ChainError } from './errors'
import type { UpstreamCapabilities } from './probe'
import type {
  AccountState,
  Address,
  BlockData,
  BlockRef,
  FailureAnalysis,
  GasOutlook,
  Hash,
  LogFilter,
  LogScan,
  NameResolution,
  PinnedBlock,
  RangeLog,
  TokenInfo,
  TransactionData,
} from './types'

/**
 * The chain port. Conventions the implementation must honor:
 * - Addresses in RESULTS are EIP-55 checksummed; lowercase is fine on the way in.
 * - Methods taking `atBlock: bigint` expect a block already pinned via pinBlock,
 *   so multi-read answers are consistent at one block.
 */
export interface ChainReader {
  chainId(): ResultAsync<bigint, ChainError>
  capabilities(): ResultAsync<UpstreamCapabilities, ChainError>
  /** Resolve a block tag or number to a concrete existing block. NOT_FOUND if it does not exist. */
  pinBlock(at: BlockRef): ResultAsync<PinnedBlock, ChainError>
  block(
    at: BlockRef | { hash: Hash },
    opts: { fullTxs: boolean },
  ): ResultAsync<BlockData | null, ChainError>
  gasOutlook(): ResultAsync<GasOutlook, ChainError>
  /** null = no L1 fee component, or unreadable. Never treat null as zero. */
  l1DataFee(): ResultAsync<bigint | null, ChainError>
  account(address: Address, atBlock: bigint): ResultAsync<AccountState, ChainError>
  /** `coinType` (ENSIP-11) selects which chain's address record to read. */
  resolveName(
    name: string,
    atBlock: bigint,
    coinType?: number,
  ): ResultAsync<NameResolution, ChainError>
  /** NOT forward-verified. `coinType` selects the ENSIP-19 chain-specific name. */
  reverseName(
    address: Address,
    atBlock: bigint,
    coinType?: number,
  ): ResultAsync<string | null, ChainError>
  tokenInfo(token: Address, atBlock: bigint): ResultAsync<TokenInfo, ChainError>
  /** ERC-165 probe. A contract without ERC-165 answers false, never an error. */
  supportsInterface(
    address: Address,
    interfaceId: `0x${string}`,
    atBlock: bigint,
  ): ResultAsync<boolean, ChainError>
  tokenBalance(token: Address, holder: Address, atBlock: bigint): ResultAsync<bigint, ChainError>
  getLogs(filter: LogFilter): ResultAsync<RangeLog[], ChainError>
  /**
   * Walk [fromBlock, toBlock] in windows, merging every filter's logs, and stop
   * as soon as `stopAfter` logs are in hand.
   *
   * The caller states the range it actually wants. This adapts to what the
   * provider really accepts — shrinking the window when the endpoint refuses one
   * and easing back up when it stops refusing — instead of enforcing a number
   * the provider never agreed to. `windowHint` seeds the first attempt only.
   */
  scanLogs(
    filters: readonly LogFilter[],
    opts: { stopAfter: number; windowHint: bigint },
  ): ResultAsync<LogScan, ChainError>
  transaction(hash: Hash): ResultAsync<TransactionData | null, ChainError>
  /**
   * Why a FAILED transaction reverted. Ladder: debug_traceTransaction when the
   * endpoint has it (exact) → eth_call replay against top-of-block state
   * (approximate — order-dependent failures may not reproduce). Never errs:
   * degradation is expressed in `method`, which is the mechanism and the
   * caveat at once.
   */
  analyzeFailure(tx: TransactionData): ResultAsync<FailureAnalysis, ChainError>
  transactionRaw(
    hash: Hash,
  ): ResultAsync<{ transaction: unknown; receipt: unknown } | null, ChainError>
}
