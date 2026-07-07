import {
  BaseError,
  ContractFunctionExecutionError,
  HttpRequestError,
  LimitExceededRpcError,
  RpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem'
import {
  type ChainError,
  internalError,
  rateLimitedError,
  rpcError,
  transportError,
} from '../errors'

export function mapViemError(e: unknown): ChainError {
  const timeout = findError(e, TimeoutError)
  if (timeout) return transportError(shortMessageOf(timeout, 'the RPC request timed out'))

  const http = findError(e, HttpRequestError)
  if (http) {
    if (http.status === 429) {
      return rateLimitedError(
        shortMessageOf(http, 'rate limited by the RPC provider'),
        parseRetryAfter(http.headers),
      )
    }
    return transportError(shortMessageOf(http, 'RPC transport error'))
  }

  const limit = findError(e, LimitExceededRpcError)
  if (limit) return rateLimitedError(shortMessageOf(limit, 'RPC rate limit exceeded'), null)

  const rpc = findError(e, RpcError)
  if (rpc) return rpcError(shortMessageOf(rpc, 'RPC error'), rpc.code)

  const contract = findError(e, ContractFunctionExecutionError)
  if (contract) return rpcError(shortMessageOf(contract, 'contract call failed'), null)

  const rawRpc = findError(e, RpcRequestError)
  if (rawRpc) {
    if (rawRpc.code === 429)
      return rateLimitedError(shortMessageOf(rawRpc, 'rate limited by the RPC provider'), null)
    return rpcError(shortMessageOf(rawRpc, 'RPC request failed'), rawRpc.code)
  }

  if (e instanceof BaseError) return internalError(shortMessageOf(e, 'unknown RPC failure'))
  return internalError(e instanceof Error ? e.message : 'unknown error')
}

type Ctor<T> = abstract new (...args: never[]) => T

function findError<T>(e: unknown, ctor: Ctor<T>): T | undefined {
  if (e instanceof ctor) return e
  if (e instanceof BaseError) {
    const found = e.walk((err) => err instanceof ctor)
    return found ? (found as T) : undefined
  }
  return undefined
}

function shortMessageOf(e: BaseError, fallback: string): string {
  return e.shortMessage || fallback
}

function parseRetryAfter(headers: Headers | undefined): number | null {
  const raw = headers?.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - Date.now())
}
