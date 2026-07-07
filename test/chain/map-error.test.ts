import {
  BaseError,
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  RpcError,
  TimeoutError,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { mapViemError } from '../../src/chain/viem/map-error'

const SECRET_URL = 'https://mainnet.example.com/v3/super-secret-api-key'

describe('mapViemError', () => {
  it('HttpRequestError 429 with Retry-After (seconds) → rate_limited with retryAfterMs', () => {
    const e = new HttpRequestError({
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      url: SECRET_URL,
    })
    expect(mapViemError(e)).toEqual({
      tag: 'rate_limited',
      message: 'HTTP request failed.',
      retryAfterMs: 5000,
    })
  })

  it('HttpRequestError 429 without Retry-After → rate_limited with null delay', () => {
    const e = new HttpRequestError({ status: 429, url: SECRET_URL })
    expect(mapViemError(e)).toEqual({
      tag: 'rate_limited',
      message: 'HTTP request failed.',
      retryAfterMs: null,
    })
  })

  it('HttpRequestError with 5xx status → transport', () => {
    const e = new HttpRequestError({ status: 503, url: SECRET_URL })
    expect(mapViemError(e)).toEqual({ tag: 'transport', message: 'HTTP request failed.' })
  })

  it('HttpRequestError without status (connection-level) → transport', () => {
    const e = new HttpRequestError({ url: SECRET_URL })
    expect(mapViemError(e)).toEqual({ tag: 'transport', message: 'HTTP request failed.' })
  })

  it('TimeoutError → transport', () => {
    const e = new TimeoutError({ body: { method: 'eth_call' }, url: SECRET_URL })
    const mapped = mapViemError(e)
    expect(mapped.tag).toBe('transport')
    expect(mapped.message).toBe('The request took too long to respond.')
  })

  it('LimitExceededRpcError → rate_limited with null delay', () => {
    const e = new LimitExceededRpcError(new Error('slow down'))
    expect(mapViemError(e)).toEqual({
      tag: 'rate_limited',
      message: 'Request exceeds defined limit.',
      retryAfterMs: null,
    })
  })

  it('InvalidParamsRpcError (RpcError subclass) → rpc with code', () => {
    const e = new InvalidParamsRpcError(new Error('bad params'))
    const mapped = mapViemError(e)
    expect(mapped.tag).toBe('rpc')
    expect(mapped).toMatchObject({ tag: 'rpc', code: -32602 })
  })

  it('generic RpcError → rpc with its short message and code', () => {
    const e = new RpcError(new Error('boom'), { code: 4200, shortMessage: 'method unsupported' })
    expect(mapViemError(e)).toEqual({ tag: 'rpc', message: 'method unsupported', code: 4200 })
  })

  it('unknown non-viem error → internal', () => {
    expect(mapViemError(new Error('something broke'))).toEqual({
      tag: 'internal',
      message: 'something broke',
    })
  })

  it('non-Error value → internal', () => {
    expect(mapViemError('nope')).toEqual({ tag: 'internal', message: 'unknown error' })
  })

  it('walks the cause chain of a wrapped viem error', () => {
    const wrapped = new BaseError('outer failure', {
      cause: new HttpRequestError({ status: 429, url: SECRET_URL }),
    })
    expect(mapViemError(wrapped)).toEqual({
      tag: 'rate_limited',
      message: 'HTTP request failed.',
      retryAfterMs: null,
    })
  })

  it('never leaks the RPC URL (which may embed an API key)', () => {
    const errors = [
      new HttpRequestError({ status: 429, url: SECRET_URL }),
      new HttpRequestError({ status: 503, url: SECRET_URL }),
      new TimeoutError({ body: {}, url: SECRET_URL }),
    ]
    for (const e of errors) {
      expect(mapViemError(e).message).not.toContain('secret')
    }
  })
})
