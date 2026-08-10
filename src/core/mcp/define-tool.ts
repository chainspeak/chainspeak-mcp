import type { McpServer } from '@modelcontextprotocol/server'
import { err, type Result, type ResultAsync } from 'neverthrow'
import type { Logger } from 'pino'
import * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { internal } from '../chain/errors'
import type { ChainHandle, ChainRegistry } from '../chain/registry'
import { chainField } from './chain-field'
import { renderToolError } from './tool-error'

export interface ToolCtx {
  /** undefined selects the server's default chain */
  resolve(chain?: string): Result<ChainHandle, ChainError>
  chains: readonly ChainHandle[]
  log: Logger
}

export type ToolArgs<In extends z.ZodObject> = z.output<In> & { chain?: string }

export interface ToolDef<In extends z.ZodObject, Out extends z.ZodObject> {
  name: `chainspeak_${string}`
  description: string
  input: In
  output: Out
  idempotent: boolean
  handler: (args: ToolArgs<In>, ctx: ToolCtx) => ResultAsync<z.output<Out>, ChainError>
}

export interface Tool {
  name: string
  description: string
  input: z.ZodObject
  output: z.ZodObject
  annotations: {
    readOnlyHint: true
    destructiveHint: false
    openWorldHint: true
    idempotentHint: boolean
  }
  register(server: McpServer, ctx: ToolCtx): void
}

export type ToolFactory = (registry: ChainRegistry) => Tool

export const defineTool =
  <In extends z.ZodObject, Out extends z.ZodObject>(def: ToolDef<In, Out>): ToolFactory =>
  (registry) => {
    const input: z.ZodObject = z.object({
      chain: chainField(registry),
      ...def.input.shape,
    })
    const output: z.ZodObject = z.object({
      chain: z.string(),
      ...def.output.shape,
    })

    return {
      name: def.name,
      description: def.description,
      input,
      output,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: def.idempotent,
      },
      register(server, ctx) {
        server.registerTool(
          def.name,
          {
            description: def.description,
            inputSchema: input,
            outputSchema: output,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: true,
              idempotentHint: def.idempotent,
            },
          },
          async (rawArgs: unknown) => {
            const log = ctx.log.child({ tool: def.name })
            const started = performance.now()
            const args = rawArgs as ToolArgs<In>

            const chain = ctx.resolve(args.chain)
            if (chain.isErr()) return toolError(log, chain.error, 0)

            const result = await run(def, args, ctx)
            const durationMs = Math.round(performance.now() - started)

            return result.match(
              (value) => {
                log.info({ durationMs, chain: chain.value.spec.key }, 'tool ok')
                const answer = { chain: chain.value.spec.key, ...value }
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
                  structuredContent: answer as Record<string, unknown>,
                }
              },
              (e) => toolError(log, e, durationMs),
            )
          },
        )
      },
    }
  }

const toolError = (
  log: Logger,
  e: ChainError,
  durationMs: number,
): { content: { type: 'text'; text: string }[]; isError: true } => {
  log.warn(
    { durationMs, errorCategory: e.category, retryable: e.retryable, error: e.message },
    'tool error',
  )
  return { content: [{ type: 'text' as const, text: renderToolError(e) }], isError: true }
}

const run = async <In extends z.ZodObject, Out extends z.ZodObject>(
  def: ToolDef<In, Out>,
  args: ToolArgs<In>,
  ctx: ToolCtx,
): Promise<Result<z.output<Out>, ChainError>> => {
  try {
    return await def.handler(args, ctx)
  } catch (e) {
    ctx.log.error({ tool: def.name, err: e }, 'tool handler panicked')
    return err(internal('unexpected failure in tool handler'))
  }
}
