import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { Chain } from 'viem'
import {
  BlockNotFoundError,
  createPublicClient,
  fallback,
  getAddress,
  hexToString,
  http,
  parseAbi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  trim,
} from 'viem'
import { estimateL1Fee } from 'viem/op-stack'
import { describeRevertData } from '../decode'
import {
  type ChainError,
  invalidInput,
  isContractCallFailure,
  notFound,
  unsupported,
} from '../errors'
import { probeUpstream, type UpstreamCapabilities } from '../probe'
import type { ChainReader } from '../reader'
import type {
  AccountState,
  Address,
  BlockData,
  BlockRef,
  FailureAnalysis,
  GasOutlook,
  Hash,
  LogFilter,
  NameResolution,
  PinnedBlock,
  RangeLog,
  TokenInfo,
  TransactionData,
} from '../types'
import { mapViemError } from './map-error'

const erc165Abi = parseAbi(['function supportsInterface(bytes4) view returns (bool)'])

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
])

const erc20Bytes32Abi = parseAbi([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Any address works for a fee estimate — only the serialized byte length matters. */
const PROBE_ACCOUNT = '0x0000000000000000000000000000000000000001' as const

export function createViemReader(cfg: {
  url: string
  fallbackUrl?: string
  timeoutMs: number
  /** enables the chain's Universal Resolver, multicall3, and OP-stack formatters */
  chain?: Chain
  /** pin CCIP-read to known gateways instead of following whatever a resolver returns */
  ensGatewayUrls?: string[]
}): ChainReader {
  // batchSize 3: free-tier providers (drpc) reject JSON-RPC batches larger than 3 —
  // exceeding it is a deterministic UPSTREAM_POLICY rejection, not a transient failure.
  // retryCount 3: server-side backoff retries for transient failures BEFORE any error
  // is surfaced to the agent.
  const opts = { batch: { batchSize: 3 }, timeout: cfg.timeoutMs, retryCount: 3 } as const
  const transports = [
    http(cfg.url, opts),
    ...(cfg.fallbackUrl ? [http(cfg.fallbackUrl, opts)] : []),
  ]
  const client = createPublicClient({
    ...(cfg.chain !== undefined ? { chain: cfg.chain } : {}),
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  })

  /** escape hatch for methods outside viem's typed public RPC schema */
  const rawRequest = client.request as unknown as (args: {
    method: string
    params?: unknown[]
  }) => Promise<unknown>

  let capsPromise: Promise<UpstreamCapabilities> | undefined

  const capabilities = (): ResultAsync<UpstreamCapabilities, ChainError> => {
    capsPromise ??= probeUpstream(cfg.url, Math.min(cfg.timeoutMs, 5000))
    return ResultAsync.fromSafePromise(capsPromise)
  }

  let cachedChainId: bigint | undefined

  const chainId = (): ResultAsync<bigint, ChainError> =>
    cachedChainId !== undefined
      ? okAsync(cachedChainId)
      : ResultAsync.fromPromise(client.getChainId(), mapViemError).map((id) => {
          cachedChainId = BigInt(id)
          return cachedChainId
        })

  const pinBlock = (at: BlockRef): ResultAsync<PinnedBlock, ChainError> =>
    ResultAsync.fromPromise(
      (typeof at === 'bigint'
        ? client.getBlock({ blockNumber: at })
        : client.getBlock({ blockTag: at })
      ).catch((e) => {
        if (e instanceof BlockNotFoundError) return null
        throw e
      }),
      mapViemError,
    ).andThen((block) =>
      block === null
        ? errAsync(
            notFound(
              `block ${String(at)} does not exist on this chain`,
              'the block number is beyond the current head (or the tag is not supported here) — use an existing block number, or a tag like latest',
            ),
          )
        : okAsync({ number: block.number, timestamp: block.timestamp }),
    )

  const block = (
    at: BlockRef | { hash: Hash },
    opts: { fullTxs: boolean },
  ): ResultAsync<BlockData | null, ChainError> => {
    const fetchBlock = (): Promise<unknown> =>
      typeof at === 'object'
        ? client.getBlock({ blockHash: at.hash, includeTransactions: opts.fullTxs })
        : typeof at === 'bigint'
          ? client.getBlock({ blockNumber: at, includeTransactions: opts.fullTxs })
          : client.getBlock({ blockTag: at, includeTransactions: opts.fullTxs })
    interface RawTx {
      hash: Hash
      from: Address
      to: Address | null
      value: bigint
      nonce: number
      type: string
    }
    interface RawBlock {
      number: bigint
      hash: Hash
      parentHash: Hash
      timestamp: bigint
      gasUsed: bigint
      gasLimit: bigint
      baseFeePerGas: bigint | null | undefined
      transactions: readonly (Hash | RawTx)[]
    }
    return ResultAsync.fromPromise(
      fetchBlock().catch((e) => {
        if (e instanceof BlockNotFoundError) return null
        throw e
      }),
      mapViemError,
    ).map((raw): BlockData | null => {
      if (raw === null) return null
      const b = raw as RawBlock
      const fullTxs = b.transactions.filter((t): t is RawTx => typeof t === 'object')
      const full = fullTxs.length > 0
      return {
        number: b.number,
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: b.timestamp,
        txCount: b.transactions.length,
        gasUsed: b.gasUsed,
        gasLimit: b.gasLimit,
        baseFeePerGasWei: b.baseFeePerGas ?? null,
        txHashes: full
          ? fullTxs.map((t) => t.hash)
          : b.transactions.filter((t): t is Hash => typeof t === 'string'),
        txs: opts.fullTxs
          ? fullTxs.map((t) => ({
              hash: t.hash,
              from: getAddress(t.from),
              to: t.to ? getAddress(t.to) : null,
              valueWei: t.value,
              nonce: t.nonce,
              txType: t.type,
            }))
          : null,
      }
    })
  }

  const gasOutlook = (): ResultAsync<GasOutlook, ChainError> => {
    const latest = ResultAsync.fromPromise(client.getBlock({ blockTag: 'latest' }), mapViemError)
    const tiers = ResultAsync.fromPromise(
      client.getFeeHistory({ blockCount: 5, rewardPercentiles: [10, 50, 90] }),
      mapViemError,
    )
      .map((h): GasOutlook['priorityTiersWei'] => {
        const rewards = (h.reward ?? []).filter((r) => r.length === 3)
        if (rewards.length === 0) return null
        const avg = (i: number): bigint =>
          rewards.reduce((acc, r) => acc + (r[i] ?? 0n), 0n) / BigInt(rewards.length)
        return { slow: avg(0), standard: avg(1), fast: avg(2) }
      })
      .orElse(() => okAsync(null))
    const blob = ResultAsync.fromPromise(client.getBlobBaseFee(), mapViemError)
      .map((v): bigint | null => v)
      .orElse(() => okAsync(null))
    const syncing = ResultAsync.fromPromise(rawRequest({ method: 'eth_syncing' }), mapViemError)
      .map((s) => s !== false)
      .orElse(() => okAsync(false))
    return ResultAsync.combine([latest, tiers, blob, syncing]).map(([b, t, bl, sy]) => ({
      baseFeeWei: b.baseFeePerGas ?? null,
      priorityTiersWei: t,
      blobBaseFeeWei: bl,
      syncing: sy,
    }))
  }

  const account = (address: Address, atBlock: bigint): ResultAsync<AccountState, ChainError> =>
    ResultAsync.fromPromise(
      // exactly 3 calls — one JSON-RPC batch at the batchSize cap
      Promise.all([
        client.getBalance({ address, blockNumber: atBlock }),
        client.getTransactionCount({ address, blockNumber: atBlock }),
        client.getCode({ address, blockNumber: atBlock }),
      ]),
      mapViemError,
    ).map(([balanceWei, nonce, code]) => {
      // EIP-7702 delegation designator: 0xef0100 ++ 20-byte delegate address.
      // A delegated EOA is NOT a contract — report the delegation instead.
      const delegatedTo =
        code !== undefined && /^0xef0100[0-9a-fA-F]{40}$/.test(code)
          ? getAddress(`0x${code.slice(8)}`)
          : null
      return {
        balanceWei,
        nonce,
        isContract: code !== undefined && code !== '0x' && delegatedTo === null,
        delegatedTo,
      }
    })

  const nullIfNotExposed = (e: ChainError): ResultAsync<null, ChainError> =>
    isContractCallFailure(e) ? okAsync(null) : errAsync(e)

  const readString = (
    token: Address,
    fn: 'symbol' | 'name',
    atBlock: bigint,
  ): ResultAsync<string | null, ChainError> =>
    ResultAsync.fromPromise(
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: fn,
        blockNumber: atBlock,
      }),
      mapViemError,
    )
      .orElse((e) =>
        !isContractCallFailure(e)
          ? errAsync<string, ChainError>(e)
          : ResultAsync.fromPromise(
              client.readContract({
                address: token,
                abi: erc20Bytes32Abi,
                functionName: fn,
                blockNumber: atBlock,
              }),
              mapViemError,
            ).map(bytes32ToString),
      )
      .orElse((e) => nullIfNotExposed(e))

  const tokenInfo = (token: Address, atBlock: bigint): ResultAsync<TokenInfo, ChainError> => {
    const decimals = ResultAsync.fromPromise(
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
        blockNumber: atBlock,
      }),
      mapViemError,
    )
      .map((d): number | null => d)
      .orElse((e) => nullIfNotExposed(e))
    const totalSupply = ResultAsync.fromPromise(
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'totalSupply',
        blockNumber: atBlock,
      }),
      mapViemError,
    )
      .map((s): bigint | null => s)
      .orElse((e) => nullIfNotExposed(e))
    const symbol = readString(token, 'symbol', atBlock)
    const name = readString(token, 'name', atBlock)

    return ResultAsync.combine([name, symbol, decimals, totalSupply]).andThen(
      ([nam, sym, dec, sup]): ResultAsync<TokenInfo, ChainError> =>
        nam === null && sym === null && dec === null && sup === null
          ? diagnoseNotAToken(token, 'none of name, symbol, decimals, or totalSupply answered')
          : okAsync({ name: nam, symbol: sym, decimals: dec, totalSupply: sup }),
    )
  }

  const tokenBalance = (
    token: Address,
    holder: Address,
    atBlock: bigint,
  ): ResultAsync<bigint, ChainError> =>
    ResultAsync.fromPromise(
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
        blockNumber: atBlock,
      }),
      mapViemError,
    ).orElse((e) =>
      isContractCallFailure(e)
        ? diagnoseNotAToken<bigint>(token, 'balanceOf did not answer')
        : errAsync(e),
    )

  const diagnoseNotAToken = <T>(token: Address, because: string): ResultAsync<T, ChainError> =>
    ResultAsync.fromPromise(client.getCode({ address: token }), mapViemError).andThen((code) => {
      const shown = getAddress(token)
      if (!code || code === '0x') {
        return errAsync<T, ChainError>(
          invalidInput(
            `${shown} has no contract code — it is a wallet, not a token contract (${because})`,
            'check the token address: it should be the ERC-20 contract, not a wallet — you may have swapped the token and holder arguments',
          ),
        )
      }
      // EIP-7702 delegation designator: a wallet that only LOOKS like a contract
      if (code.startsWith('0xef0100')) {
        return errAsync<T, ChainError>(
          invalidInput(
            `${shown} is an EIP-7702 delegated wallet, not a token contract (${because})`,
            'this address is an EOA whose code is a delegation pointer, so it holds no ERC-20 state — pass the token contract address instead, or use chainspeak_get_account to inspect the wallet',
          ),
        )
      }
      return errAsync<T, ChainError>(
        invalidInput(
          `contract ${shown} does not behave like an ERC-20 token (${because})`,
          'verify the address really is an ERC-20 token contract; NFTs and other contracts need different tools',
        ),
      )
    })

  const supportsInterface = (
    address: Address,
    interfaceId: `0x${string}`,
    atBlock: bigint,
  ): ResultAsync<boolean, ChainError> =>
    ResultAsync.fromPromise(
      client.readContract({
        address,
        abi: erc165Abi,
        functionName: 'supportsInterface',
        args: [interfaceId],
        blockNumber: atBlock,
      }),
      mapViemError,
      // no ERC-165 means the contract reverts, which answers the question
    ).orElse((e) => (isContractCallFailure(e) ? okAsync(false) : errAsync(e)))

  const transaction = (hash: Hash): ResultAsync<TransactionData | null, ChainError> => {
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
    return ResultAsync.combine([tx, receipt]).map(([t, r]): TransactionData | null =>
      t === null
        ? null
        : {
            hash,
            status: r === null ? 'pending' : r.status === 'reverted' ? 'failed' : 'success',
            from: getAddress(t.from),
            to: t.to ? getAddress(t.to) : null,
            createdContract: r?.contractAddress ? getAddress(r.contractAddress) : null,
            valueWei: t.value,
            nonce: t.nonce,
            txType: t.type,
            gasLimit: t.gas,
            input: t.input,
            maxFeePerGasWei: t.maxFeePerGas ?? null,
            maxPriorityFeePerGasWei: t.maxPriorityFeePerGas ?? null,
            authorizationList:
              t.authorizationList?.map((a) => ({
                chainId: BigInt(a.chainId).toString(),
                address: getAddress(a.address),
                nonce: BigInt(a.nonce).toString(),
              })) ?? null,
            maxFeePerBlobGasWei: t.maxFeePerBlobGas ?? null,
            blobVersionedHashes: t.blobVersionedHashes ?? null,
            blockNumber: r?.blockNumber ?? null,
            gasUsed: r?.gasUsed ?? null,
            effectiveGasPriceWei: r?.effectiveGasPrice ?? null,
            blobGasUsed: r?.blobGasUsed ?? null,
            blobGasPriceWei: r?.blobGasPrice ?? null,
            logs:
              r?.logs.map((l) => ({
                address: getAddress(l.address),
                topics: l.topics,
                data: l.data,
                logIndex: l.logIndex,
              })) ?? null,
          },
    )
  }

  const transactionRaw = (
    hash: Hash,
  ): ResultAsync<{ transaction: unknown; receipt: unknown } | null, ChainError> =>
    ResultAsync.fromPromise(
      Promise.all([
        client.request({ method: 'eth_getTransactionByHash', params: [hash] }),
        client.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
      ]),
      mapViemError,
    ).map(([t, r]) => (t === null ? null : { transaction: t, receipt: r }))

  const getLogs = (filter: LogFilter): ResultAsync<RangeLog[], ChainError> =>
    ResultAsync.fromPromise(
      rawRequest({
        method: 'eth_getLogs',
        params: [
          {
            ...(filter.address !== undefined ? { address: filter.address } : {}),
            ...(filter.topics !== undefined ? { topics: filter.topics } : {}),
            fromBlock: `0x${filter.fromBlock.toString(16)}`,
            toBlock: `0x${filter.toBlock.toString(16)}`,
          },
        ],
      }),
      mapViemError,
    ).map((res): RangeLog[] => {
      if (!Array.isArray(res)) return []
      interface RawLog {
        address: string
        topics: `0x${string}`[]
        data: `0x${string}`
        blockNumber: `0x${string}`
        transactionHash: Hash
        logIndex: `0x${string}`
      }
      return (res as RawLog[]).map((l) => ({
        address: getAddress(l.address),
        topics: l.topics,
        data: l.data,
        blockNumber: BigInt(l.blockNumber),
        txHash: l.transactionHash,
        logIndex: Number(l.logIndex),
      }))
    })

  /** Walk an error's cause chain for revert return data (viem nests provider errors). */
  const revertDataOf = (e: unknown): `0x${string}` | null => {
    let cur: unknown = e
    for (let i = 0; i < 8 && typeof cur === 'object' && cur !== null; i++) {
      const rec = cur as Record<string, unknown>
      const d = rec['data']
      if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d as `0x${string}`
      if (typeof d === 'object' && d !== null) {
        const dd = (d as Record<string, unknown>)['data']
        if (typeof dd === 'string' && /^0x[0-9a-fA-F]*$/.test(dd)) return dd as `0x${string}`
      }
      cur = rec['cause']
    }
    return null
  }

  /** Trace path: exact revert frame from debug_traceTransaction. null = trace shows no failure. */
  const traceFailure = (tx: TransactionData): ResultAsync<FailureAnalysis | null, ChainError> =>
    ResultAsync.fromPromise(
      rawRequest({ method: 'debug_traceTransaction', params: [tx.hash, { tracer: 'callTracer' }] }),
      mapViemError,
    ).map((res): FailureAnalysis | null => {
      if (typeof res !== 'object' || res === null) return null
      const frame = res as { error?: string; revertReason?: string; output?: string }
      if (frame.error === undefined) return null
      const data =
        typeof frame.output === 'string' && /^0x[0-9a-fA-F]*$/.test(frame.output)
          ? (frame.output as `0x${string}`)
          : null
      const reason =
        frame.revertReason !== undefined && frame.revertReason !== ''
          ? `reverted with reason: "${frame.revertReason}"`
          : data !== null && data !== '0x'
            ? describeRevertData(data)
            : `failed with: ${frame.error}`
      return { reason, revertData: data, method: 'trace', confidence: 'exact', note: null }
    })

  /** Replay path: eth_call with the tx's fields against top-of-block state (block N-1). */
  const replayFailure = (tx: TransactionData): ResultAsync<FailureAnalysis, ChainError> => {
    if (tx.blockNumber === null) {
      return okAsync({
        reason: 'the transaction is still pending — nothing to analyze yet',
        revertData: null,
        method: 'none',
        confidence: 'none',
        note: null,
      })
    }
    const callParams: Record<string, string> = {
      from: tx.from,
      value: `0x${tx.valueWei.toString(16)}`,
      data: tx.input,
      gas: `0x${tx.gasLimit.toString(16)}`,
      ...(tx.to === null ? {} : { to: tx.to }),
    }
    const atBlock = `0x${(tx.blockNumber - 1n).toString(16)}`
    return ResultAsync.fromSafePromise(
      rawRequest({ method: 'eth_call', params: [callParams, atBlock] }).then(
        () => null as unknown,
        (e) => ({ replayError: e }),
      ),
    ).map((outcome): FailureAnalysis => {
      if (outcome === null || typeof outcome !== 'object' || !('replayError' in outcome)) {
        return {
          reason:
            'could not reproduce: the call succeeds against top-of-block state — the failure was state- or order-dependent (e.g. a balance or condition changed by an earlier transaction in the same block)',
          revertData: null,
          method: 'replay',
          confidence: 'none',
          note: null,
        }
      }
      const data = revertDataOf(outcome.replayError)
      return {
        reason:
          data !== null
            ? describeRevertData(data)
            : `reverted on replay without recoverable revert data (provider said: ${mapViemError(outcome.replayError).message})`,
        revertData: data,
        method: 'replay',
        confidence: 'approximate',
        note: null,
      }
    })
  }

  const analyzeFailure = (tx: TransactionData): ResultAsync<FailureAnalysis, ChainError> =>
    capabilities().andThen((caps) => {
      const unavailable: FailureAnalysis = {
        reason:
          'failure analysis unavailable: the RPC endpoint answered neither a trace nor a replay',
        revertData: null,
        method: 'none',
        confidence: 'none',
        note: null,
      }
      // No silent fallback: whenever the path taken differs from what the probed
      // capabilities promised, the note says why (the field-test defect).
      const replayWithNote = (note: string | null): ResultAsync<FailureAnalysis, ChainError> =>
        replayFailure(tx)
          .map((a) => ({ ...a, note: a.note ?? note }))
          .orElse(() => okAsync({ ...unavailable, note }))
      if (caps.trace !== true) {
        return replayWithNote(
          caps.trace === false
            ? 'the RPC endpoint has no debug_traceTransaction (probed) — replay is the best available method'
            : 'trace support unknown (probe inconclusive) — replay used',
        )
      }
      // A load-balanced endpoint answers trace from whichever node it picks, and
      // not all of them carry debug_. Retrying once in-process makes `confidence`
      // stable across identical calls instead of flapping exact/approximate, and
      // spares the caller a retry the note used to ask them to make themselves.
      const traceOnce = (): ResultAsync<FailureAnalysis | null, ChainError> => traceFailure(tx)
      return traceOnce()
        .orElse((e) => (e.retryable ? traceOnce() : errAsync(e)))
        .andThen((fromTrace) =>
          fromTrace !== null
            ? okAsync(fromTrace)
            : replayWithNote(
                'trace answered but reported no failing frame for this transaction — replay used',
              ),
        )
        .orElse((e) =>
          replayWithNote(
            `trace attempted twice and failed (${e.category}: ${e.message}) — replay used; the endpoint served this call from a node without debug_traceTransaction`,
          ),
        )
    })

  /** Via the Universal Resolver, so ENSIP-10 wildcards and CCIP-read work. */
  const ensUnavailable = <T>(): ResultAsync<T, ChainError> =>
    errAsync(
      unsupported(
        'this endpoint serves a chain with no ENS Universal Resolver deployment',
        'resolve the name on a chain that has ENS (ethereum), then use the resulting 0x address here — addresses are portable across EVM chains',
      ),
    )

  const hasEns = (): boolean => client.chain?.contracts?.ensUniversalResolver !== undefined

  /** Below the resolver's deployment height there is nothing to call. */
  const ensDeployedAt = (atBlock: bigint): ChainError | null => {
    const created = client.chain?.contracts?.ensUniversalResolver?.blockCreated
    if (created === undefined || atBlock >= BigInt(created)) return null
    return unsupported(
      `ENS cannot be read at block ${atBlock}: the ENS Universal Resolver was deployed at block ${created}`,
      `ask at block ${created} or later, or omit the block to use the chain head — ENS state before the resolver deployment is not reachable this way`,
    )
  }

  const ensOpts = (atBlock: bigint, coinType?: number) => ({
    blockNumber: atBlock,
    ...(coinType !== undefined ? { coinType: BigInt(coinType) } : {}),
    ...(cfg.ensGatewayUrls !== undefined ? { gatewayUrls: cfg.ensGatewayUrls } : {}),
  })

  /** Any failure degrades to null: a missing estimate is honest, a wrong one is not. */
  const l1DataFee = (): ResultAsync<bigint | null, ChainError> => {
    const chain = cfg.chain
    if (chain === undefined || chain.contracts?.['gasPriceOracle'] === undefined) {
      return okAsync(null)
    }
    return ResultAsync.fromPromise(
      estimateL1Fee(client, {
        chain,
        account: PROBE_ACCOUNT,
        to: PROBE_ACCOUNT,
        value: 0n,
        data: '0x',
      }),
      mapViemError,
    ).orElse(() => okAsync(null))
  }

  const resolveName = (
    name: string,
    atBlock: bigint,
    coinType?: number,
  ): ResultAsync<NameResolution, ChainError> => {
    if (!hasEns()) return ensUnavailable()
    const tooEarly = ensDeployedAt(atBlock)
    if (tooEarly !== null) return errAsync(tooEarly)
    return ResultAsync.fromPromise(
      client.getEnsAddress({ name, ...ensOpts(atBlock, coinType) }),
      mapViemError,
    ).map((address) =>
      address !== null && address.toLowerCase() !== ZERO_ADDRESS
        ? { address: getAddress(address) }
        : // the Universal Resolver answers for any name, so absence is unprovable
          { address: null },
    )
  }

  const reverseName = (
    address: Address,
    atBlock: bigint,
    coinType?: number,
  ): ResultAsync<string | null, ChainError> => {
    if (!hasEns()) return ensUnavailable()
    const tooEarly = ensDeployedAt(atBlock)
    if (tooEarly !== null) return errAsync(tooEarly)
    return ResultAsync.fromPromise(
      client.getEnsName({ address, ...ensOpts(atBlock, coinType) }),
      mapViemError,
    ).map((name) => (name === '' ? null : name))
  }

  return {
    chainId,
    capabilities,
    pinBlock,
    block,
    gasOutlook,
    l1DataFee,
    account,
    resolveName,
    reverseName,
    tokenInfo,
    supportsInterface,
    tokenBalance,
    getLogs,
    transaction,
    transactionRaw,
    analyzeFailure,
  }
}

function bytes32ToString(value: `0x${string}`): string {
  const trimmed = trim(value, { dir: 'right' })
  return trimmed === '0x' ? '' : hexToString(trimmed)
}
