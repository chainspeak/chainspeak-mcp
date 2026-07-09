import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import {
  concat,
  createPublicClient,
  fallback,
  hexToString,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  trim,
} from 'viem'
import { type ChainError, invalidInputError } from '../errors'
import type { ChainReader } from '../reader'
import type {
  Address,
  BlockRef,
  ChainInfo,
  FeeEstimate,
  Hash,
  TokenBalance,
  TransactionSummary,
} from '../types'
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

const ensRegistryAbi = parseAbi(['function resolver(bytes32 node) view returns (address)'])
const ensResolverAbi = parseAbi(['function addr(bytes32 node) view returns (address)'])

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

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

  const transaction = (hash: Hash): ResultAsync<TransactionSummary | null, ChainError> => {
    const tx = ResultAsync.fromPromise(
      client.getTransaction({ hash }).catch((e) => {
        if (e instanceof TransactionNotFoundError) return null
        throw e
      }),
      mapViemError,
    )
    const receipt = ResultAsync.fromPromise(
      client.getTransactionReceipt({ hash }).catch((e) => {
        if (e instanceof TransactionReceiptNotFoundError) return null
        throw e
      }),
      mapViemError,
    )
    return ResultAsync.combine([tx, receipt]).map(([t, r]): TransactionSummary | null =>
      t === null
        ? null
        : {
            status: r === null ? 'pending' : r.status === 'reverted' ? 'failed' : 'success',
            from: t.from.toLowerCase() as Address,
            to: t.to ? (t.to.toLowerCase() as Address) : null,
            valueWei: t.value,
            blockNumber: r?.blockNumber ?? null,
            gasUsed: r?.gasUsed ?? null,
            effectiveGasPriceWei: r?.effectiveGasPrice ?? null,
            logCount: r?.logs.length ?? null,
          },
    )
  }

  const resolveEns = (name: string): ResultAsync<Address | null, ChainError> => {
    const node = namehash(name)
    return ResultAsync.fromPromise(
      client.readContract({
        address: ENS_REGISTRY,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
      }),
      mapViemError,
    ).andThen((resolver) =>
      resolver.toLowerCase() === ZERO_ADDRESS
        ? okAsync(null)
        : ResultAsync.fromPromise(
            client.readContract({
              address: resolver,
              abi: ensResolverAbi,
              functionName: 'addr',
              args: [node],
            }),
            mapViemError,
          )
            .map((addr): Address | null =>
              addr.toLowerCase() === ZERO_ADDRESS ? null : (addr.toLowerCase() as Address),
            )
            .orElse((e) => (e.tag === 'rpc' ? okAsync(null) : errAsync(e))),
    )
  }

  const feeEstimate = (): ResultAsync<FeeEstimate, ChainError> =>
    ResultAsync.fromPromise(
      Promise.all([client.getBlock({ blockTag: 'latest' }), client.estimateMaxPriorityFeePerGas()]),
      mapViemError,
    ).map(([block, priority]) => ({
      baseFeeWei: block.baseFeePerGas ?? null,
      maxPriorityFeeWei: priority,
    }))

  return { chainInfo, balance, tokenBalance, transaction, resolveEns, feeEstimate }
}

function bytes32ToString(value: `0x${string}`): string {
  const trimmed = trim(value, { dir: 'right' })
  return trimmed === '0x' ? '' : hexToString(trimmed)
}

function namehash(name: string): Hash {
  let node: Hash = `0x${'00'.repeat(32)}`
  for (const label of name.split('.').reverse()) {
    node = keccak256(concat([node, keccak256(stringToHex(label))]))
  }
  return node
}
