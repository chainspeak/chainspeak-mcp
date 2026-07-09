import type { ResultAsync } from 'neverthrow'
import type { ChainError } from './errors'
import type {
  Address,
  BlockRef,
  ChainInfo,
  FeeEstimate,
  Hash,
  TokenBalance,
  TransactionSummary,
} from './types'

export interface ChainReader {
  chainInfo(): ResultAsync<ChainInfo, ChainError>
  balance(address: Address, at: BlockRef): ResultAsync<bigint, ChainError>
  tokenBalance(token: Address, holder: Address): ResultAsync<TokenBalance, ChainError>
  transaction(hash: Hash): ResultAsync<TransactionSummary | null, ChainError>
  resolveEns(name: string): ResultAsync<Address | null, ChainError>
  feeEstimate(): ResultAsync<FeeEstimate, ChainError>
}
