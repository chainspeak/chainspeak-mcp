import * as z from 'zod'

const ConfigSchema = z.object({
  /** which chain a bare ETH_RPC_URL serves, and the default chain when several are configured */
  CHAIN: z.string().min(1).default('ethereum'),
  ETH_RPC_URL: z.url().optional(),
  ETH_RPC_URL_FALLBACK: z.url().optional(),
  ETH_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  MCP_AUTH_TOKEN: z.string().min(16, 'use at least 16 characters').optional(),
})

export interface RpcEntry {
  /** chain name, alias, or id as written in the env var */
  selector: string
  url: string
  fallbackUrl?: string
}

export type AppConfig = z.infer<typeof ConfigSchema> & { rpcs: readonly RpcEntry[] }

const RPC_PREFIX = 'RPC_URL_'
const FALLBACK_SUFFIX = '_FALLBACK'

/** RPC_URL_BASE / RPC_URL_OP_MAINNET / RPC_URL_8453 -> base / op-mainnet / 8453 */
const selectorOf = (envKey: string): string => envKey.toLowerCase().replace(/_/g, '-')

const collectRpcs = (env: NodeJS.ProcessEnv, base: z.infer<typeof ConfigSchema>): RpcEntry[] => {
  const found = new Map<string, { url?: string; fallbackUrl?: string }>()
  const put = (selector: string, patch: { url?: string; fallbackUrl?: string }): void => {
    found.set(selector, { ...found.get(selector), ...patch })
  }

  if (base.ETH_RPC_URL !== undefined) {
    put(base.CHAIN, {
      url: base.ETH_RPC_URL,
      ...(base.ETH_RPC_URL_FALLBACK !== undefined
        ? { fallbackUrl: base.ETH_RPC_URL_FALLBACK }
        : {}),
    })
  }

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(RPC_PREFIX) || value === undefined || value === '') continue
    const rest = key.slice(RPC_PREFIX.length)
    if (rest.endsWith(FALLBACK_SUFFIX)) {
      put(selectorOf(rest.slice(0, -FALLBACK_SUFFIX.length)), { fallbackUrl: value })
    } else {
      put(selectorOf(rest), { url: value })
    }
  }

  const entries: RpcEntry[] = []
  for (const [selector, { url, fallbackUrl }] of found) {
    if (url === undefined) {
      throw new Error(
        `invalid server configuration:\nRPC_URL_${selector.toUpperCase().replace(/-/g, '_')}${FALLBACK_SUFFIX} is set without its primary RPC_URL_${selector.toUpperCase().replace(/-/g, '_')}`,
      )
    }
    entries.push({ selector, url, ...(fallbackUrl !== undefined ? { fallbackUrl } : {}) })
  }
  return entries
}

export const loadConfig = (env: NodeJS.ProcessEnv): AppConfig => {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    throw new Error(`invalid server configuration:\n${z.prettifyError(result.error)}`)
  }
  const rpcs = collectRpcs(env, result.data)
  if (rpcs.length === 0) {
    throw new Error(
      'invalid server configuration:\nno RPC endpoint configured — set ETH_RPC_URL, or one RPC_URL_<CHAIN> per chain (e.g. RPC_URL_BASE)',
    )
  }
  return { ...result.data, rpcs }
}
