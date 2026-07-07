import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('accepts a minimal env and applies defaults', () => {
    const cfg = loadConfig({ ETH_RPC_URL: 'https://rpc.example.com' })
    expect(cfg).toEqual<AppConfig>({
      ETH_RPC_URL: 'https://rpc.example.com',
      ETH_RPC_TIMEOUT_MS: 10000,
      LOG_LEVEL: 'info',
      HTTP_PORT: 3000,
      HTTP_HOST: '0.0.0.0',
    })
    expect(cfg.ETH_RPC_URL_FALLBACK).toBeUndefined()
    expect(cfg.MCP_AUTH_TOKEN).toBeUndefined()
  })

  it('accepts all fields set, coercing numbers', () => {
    const cfg = loadConfig({
      ETH_RPC_URL: 'https://rpc.example.com',
      ETH_RPC_URL_FALLBACK: 'https://fallback.example.com',
      ETH_RPC_TIMEOUT_MS: '5000',
      LOG_LEVEL: 'debug',
      HTTP_PORT: '8080',
      HTTP_HOST: '127.0.0.1',
      MCP_AUTH_TOKEN: 'a-long-enough-secret-token',
    })
    expect(cfg).toEqual<AppConfig>({
      ETH_RPC_URL: 'https://rpc.example.com',
      ETH_RPC_URL_FALLBACK: 'https://fallback.example.com',
      ETH_RPC_TIMEOUT_MS: 5000,
      LOG_LEVEL: 'debug',
      HTTP_PORT: 8080,
      HTTP_HOST: '127.0.0.1',
      MCP_AUTH_TOKEN: 'a-long-enough-secret-token',
    })
  })

  const failures: { name: string; env: NodeJS.ProcessEnv; needle: RegExp }[] = [
    { name: 'missing ETH_RPC_URL', env: {}, needle: /ETH_RPC_URL/ },
    { name: 'malformed ETH_RPC_URL', env: { ETH_RPC_URL: 'not-a-url' }, needle: /ETH_RPC_URL/ },
    {
      name: 'non-positive ETH_RPC_TIMEOUT_MS',
      env: { ETH_RPC_URL: 'https://rpc.example.com', ETH_RPC_TIMEOUT_MS: '-5' },
      needle: /ETH_RPC_TIMEOUT_MS/,
    },
    {
      name: 'non-numeric ETH_RPC_TIMEOUT_MS',
      env: { ETH_RPC_URL: 'https://rpc.example.com', ETH_RPC_TIMEOUT_MS: 'soon' },
      needle: /ETH_RPC_TIMEOUT_MS/,
    },
    {
      name: 'unknown LOG_LEVEL',
      env: { ETH_RPC_URL: 'https://rpc.example.com', LOG_LEVEL: 'verbose' },
      needle: /LOG_LEVEL/,
    },
    {
      name: 'short MCP_AUTH_TOKEN',
      env: { ETH_RPC_URL: 'https://rpc.example.com', MCP_AUTH_TOKEN: 'short' },
      needle: /MCP_AUTH_TOKEN/,
    },
    {
      name: 'out-of-range HTTP_PORT',
      env: { ETH_RPC_URL: 'https://rpc.example.com', HTTP_PORT: '70000' },
      needle: /HTTP_PORT/,
    },
  ]

  for (const { name, env, needle } of failures) {
    it(`throws helpful text on ${name}`, () => {
      expect(() => loadConfig(env)).toThrow(needle)
    })
  }
})
