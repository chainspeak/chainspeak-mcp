import {
  BaseError,
  ContractFunctionExecutionError,
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  MethodNotFoundRpcError,
  RpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { isContractCallFailure } from '../../src/core/chain/errors'
import { mapViemError } from '../../src/core/chain/viem/map-error'

const SECRET_URL = 'https://mainnet.example.com/v3/super-secret-api-key'

describe('mapViemError', () => {
  it('HttpRequestError 429 with Retry-After (seconds) → UPSTREAM_TRANSIENT with retryAfterMs', () => {
    const e = new HttpRequestError({
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      url: SECRET_URL,
    })
    const mapped = mapViemError(e)
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryable).toBe(true)
    expect(mapped.retryAfterMs).toBe(5000)
  })

  it('HttpRequestError 429 without Retry-After → UPSTREAM_TRANSIENT with null delay', () => {
    const e = new HttpRequestError({ status: 429, url: SECRET_URL })
    const mapped = mapViemError(e)
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryAfterMs).toBeNull()
  })

  it('HttpRequestError 5xx → UPSTREAM_TRANSIENT (server hiccup, already retried)', () => {
    const mapped = mapViemError(new HttpRequestError({ status: 503, url: SECRET_URL }))
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.retryable).toBe(true)
  })

  it('HttpRequestError 4xx (non-429) → UPSTREAM_POLICY, never retryable', () => {
    const mapped = mapViemError(new HttpRequestError({ status: 413, url: SECRET_URL }))
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.retryable).toBe(false)
    expect(mapped.hint).toContain('deterministic')
  })

  it('HttpRequestError without status (connection-level) → UPSTREAM_TRANSIENT', () => {
    const mapped = mapViemError(new HttpRequestError({ url: SECRET_URL }))
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
  })

  it('TimeoutError → UPSTREAM_TRANSIENT', () => {
    const mapped = mapViemError(new TimeoutError({ body: { method: 'eth_call' }, url: SECRET_URL }))
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
    expect(mapped.message).toBe('The request took too long to respond.')
  })

  it('LimitExceededRpcError with rate-limit wording → UPSTREAM_TRANSIENT', () => {
    const mapped = mapViemError(
      new LimitExceededRpcError(new Error('slow down, too many requests')),
    )
    expect(mapped.category).toBe('UPSTREAM_TRANSIENT')
  })

  it('LimitExceededRpcError with a batch-size cap → UPSTREAM_POLICY, never retryable (the drpc retry-spiral bug)', () => {
    const mapped = mapViemError(
      new LimitExceededRpcError(new Error('batch of more than 3 requests is not allowed')),
    )
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.retryable).toBe(false)
    expect(mapped.message).toContain('batch of more than 3')
    expect(mapped.hint).toContain('smaller')
  })

  it('MethodNotFoundRpcError → UNSUPPORTED', () => {
    const mapped = mapViemError(
      new MethodNotFoundRpcError(new Error('method eth_feeHistory not found')),
    )
    expect(mapped.category).toBe('UNSUPPORTED')
    expect(mapped.retryable).toBe(false)
  })

  it('missing trie node (pruned state) → HISTORICAL_STATE_UNAVAILABLE, steering on distance first', () => {
    const e = new RpcError(new Error('missing trie node abc123'), {
      code: -32000,
      shortMessage: 'missing trie node abc123',
    })
    const mapped = mapViemError(e)
    // Its own category: this is where a history limit is learned now that the
    // archive probe is gone, so it must not be lumped in with UNSUPPORTED.
    expect(mapped.category).toBe('HISTORICAL_STATE_UNAVAILABLE')
    expect(mapped.retryable).toBe(false)
    // Both ways out, nearer block before "go buy an archive node".
    expect(mapped.hint).toContain('closer to the head')
    expect(mapped.hint).toContain('archive')
  })

  it('InvalidParamsRpcError → UPSTREAM_POLICY with the code propagated', () => {
    const mapped = mapViemError(new InvalidParamsRpcError(new Error('bad params')))
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.message).toContain('-32602')
  })

  it('generic RpcError → UPSTREAM_POLICY carrying the provider text', () => {
    const e = new RpcError(new Error('boom'), { code: 4200, shortMessage: 'method unsupported' })
    const mapped = mapViemError(e)
    expect(mapped.category).toBe('UPSTREAM_POLICY')
    expect(mapped.message).toContain('4200')
  })

  it('contract execution failure → INVALID_INPUT flagged as a contract-call failure', () => {
    const e = new ContractFunctionExecutionError(new BaseError('execution reverted'), {
      abi: [],
      functionName: 'symbol',
    })
    const mapped = mapViemError(e)
    expect(mapped.category).toBe('INVALID_INPUT')
    expect(isContractCallFailure(mapped)).toBe(true)
  })

  it('execution-reverted RpcRequestError → contract-call failure, not policy', () => {
    const e = new RpcRequestError({
      body: { method: 'eth_call' },
      url: SECRET_URL,
      error: { code: -32000, message: 'execution reverted' },
    })
    const mapped = mapViemError(e)
    expect(isContractCallFailure(mapped)).toBe(true)
  })

  it('unknown non-viem error → INTERNAL', () => {
    const mapped = mapViemError(new Error('something broke'))
    expect(mapped.category).toBe('INTERNAL')
    expect(mapped.message).toBe('something broke')
    expect(mapped.retryable).toBe(false)
  })

  it('non-Error value → INTERNAL', () => {
    expect(mapViemError('nope').category).toBe('INTERNAL')
  })

  it('walks the cause chain of a wrapped viem error', () => {
    const wrapped = new BaseError('outer failure', {
      cause: new HttpRequestError({ status: 429, url: SECRET_URL }),
    })
    expect(mapViemError(wrapped).category).toBe('UPSTREAM_TRANSIENT')
  })

  it('retryable is true ONLY for UPSTREAM_TRANSIENT', () => {
    const cases = [
      new HttpRequestError({ status: 413, url: SECRET_URL }),
      new LimitExceededRpcError(new Error('batch too large')),
      new InvalidParamsRpcError(new Error('bad params')),
      new MethodNotFoundRpcError(new Error('nope')),
      new Error('bug'),
    ]
    for (const e of cases) {
      const mapped = mapViemError(e)
      expect(mapped.retryable, `${mapped.category} must not be retryable`).toBe(false)
    }
  })

  it('never leaks the RPC URL (which may embed an API key)', () => {
    const errors = [
      new HttpRequestError({ status: 429, url: SECRET_URL }),
      new HttpRequestError({ status: 503, url: SECRET_URL }),
      new HttpRequestError({ status: 413, url: SECRET_URL }),
      new TimeoutError({ body: {}, url: SECRET_URL }),
      new RpcRequestError({
        body: { method: 'eth_call' },
        url: SECRET_URL,
        error: { code: -32097, message: 'daily request cap reached' },
      }),
    ]
    for (const e of errors) {
      const mapped = mapViemError(e)
      expect(JSON.stringify(mapped)).not.toContain('secret')
    }
  })
})
