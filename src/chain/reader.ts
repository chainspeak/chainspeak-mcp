import type { ResultAsync } from 'neverthrow'
import type { ChainError } from './errors'
import type { Address, BlockRef, ChainInfo, TokenBalance } from './types'

export interface ChainReader {
  chainInfo(): ResultAsync<ChainInfo, ChainError>
  balance(address: Address, at: BlockRef): ResultAsync<bigint, ChainError>
  tokenBalance(token: Address, holder: Address): ResultAsync<TokenBalance, ChainError>
}
