import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { createPublicClient, fallback, hexToString, http, parseAbi, trim } from 'viem'
import { type ChainError, invalidInputError } from '../errors'
import type { ChainReader } from '../reader'
import type { Address, BlockRef, ChainInfo, TokenBalance } from '../types'
import { mapViemError } from './map-error'

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])

const erc20Bytes32Abi = parseAbi([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
])

export function createViemReader(cfg: {
  url: string
  fallbackUrl?: string
  timeoutMs: number
}): ChainReader {
  const opts = { batch: true, timeout: cfg.timeoutMs, retryCount: 3 } as const
  const transports = [
    http(cfg.url, opts),
    ...(cfg.fallbackUrl ? [http(cfg.fallbackUrl, opts)] : []),
  ]
  const client = createPublicClient({
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  })

  const chainInfo = (): ResultAsync<ChainInfo, ChainError> =>
    ResultAsync.fromPromise(
      Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' })]),
      mapViemError,
    ).map(([id, block]) => ({
      chainId: BigInt(id),
      latestBlock: block.number,
      baseFeeWei: block.baseFeePerGas ?? null,
    }))

  const balance = (address: Address, at: BlockRef): ResultAsync<bigint, ChainError> =>
    ResultAsync.fromPromise(
      client.getBalance(
        typeof at === 'bigint' ? { address, blockNumber: at } : { address, blockTag: at },
      ),
      mapViemError,
    )

  const nullIfNotExposed = (e: ChainError): ResultAsync<null, ChainError> =>
    e.tag === 'rpc' ? okAsync(null) : errAsync(e)

  const readString = (
    token: Address,
    fn: 'symbol' | 'name',
  ): ResultAsync<string | null, ChainError> =>
    ResultAsync.fromPromise(
      client.readContract({ address: token, abi: erc20Abi, functionName: fn }),
      mapViemError,
    )
      .orElse((e) =>
        e.tag !== 'rpc'
          ? errAsync<string, ChainError>(e)
          : ResultAsync.fromPromise(
              client.readContract({ address: token, abi: erc20Bytes32Abi, functionName: fn }),
              mapViemError,
            ).map(bytes32ToString),
      )
      .orElse((e) => nullIfNotExposed(e))

  const tokenBalance = (token: Address, holder: Address): ResultAsync<TokenBalance, ChainError> => {
    const rawBalance = ResultAsync.fromPromise(
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      }),
      mapViemError,
    )
    const decimals = ResultAsync.fromPromise(
      client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      mapViemError,
    )
      .map((d): number | null => d)
      .orElse((e) => nullIfNotExposed(e))
    const symbol = readString(token, 'symbol')
    const name = readString(token, 'name')

    return rawBalance
      .andThen((raw) =>
        ResultAsync.combine([decimals, symbol, name]).map(
          ([dec, sym, nam]): TokenBalance => ({ raw, decimals: dec, symbol: sym, name: nam }),
        ),
      )
      .orElse((e) => (e.tag === 'rpc' ? diagnoseBalanceOfFailure(token) : errAsync(e)))
  }

  const diagnoseBalanceOfFailure = (token: Address): ResultAsync<TokenBalance, ChainError> =>
    ResultAsync.fromPromise(client.getCode({ address: token }), mapViemError).andThen((code) =>
      !code || code === '0x'
        ? errAsync(
            invalidInputError(
              `address ${token} is not a contract — cannot read an ERC-20 balance from it`,
            ),
          )
        : errAsync(
            invalidInputError(
              `contract ${token} does not expose balanceOf — it does not appear to be an ERC-20 token`,
            ),
          ),
    )

  return { chainInfo, balance, tokenBalance }
}

function bytes32ToString(value: `0x${string}`): string {
  const trimmed = trim(value, { dir: 'right' })
  return trimmed === '0x' ? '' : hexToString(trimmed)
}
