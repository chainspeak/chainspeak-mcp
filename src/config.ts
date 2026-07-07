import * as z from 'zod'

const ConfigSchema = z.object({
  ETH_RPC_URL: z.url(),
  ETH_RPC_URL_FALLBACK: z.url().optional(),
  ETH_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  MCP_AUTH_TOKEN: z.string().min(16, 'use at least 16 characters').optional(),
})

export type AppConfig = z.infer<typeof ConfigSchema>

export const loadConfig = (env: NodeJS.ProcessEnv): AppConfig => {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    throw new Error(`invalid server configuration:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
