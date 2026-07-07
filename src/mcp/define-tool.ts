import type { McpServer } from '@modelcontextprotocol/server'
import { err, type Result, type ResultAsync } from 'neverthrow'
import type { Logger } from 'pino'
import type * as z from 'zod'
import type { ChainError } from '../chain/errors'
import { internalError } from '../chain/errors'
import type { ChainReader } from '../chain/reader'
import { renderToolError } from './tool-error'

export interface ToolCtx {
  readerFor(chain?: string): Result<ChainReader, ChainError>
  log: Logger
}

export interface ToolDef<In extends z.ZodObject, Out extends z.ZodObject> {
  name: `eth_${string}`
  description: string
  input: In
  output: Out
  idempotent: boolean
  handler: (args: z.output<In>, ctx: ToolCtx) => ResultAsync<z.output<Out>, ChainError>
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

export const defineTool = <In extends z.ZodObject, Out extends z.ZodObject>(
  def: ToolDef<In, Out>,
): Tool => ({
  name: def.name,
  description: def.description,
  input: def.input,
  output: def.output,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: def.idempotent,
  },
  register(server, ctx) {
    const inputSchema: z.ZodObject = def.input
    const outputSchema: z.ZodObject = def.output
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
          idempotentHint: def.idempotent,
        },
      },
      async (args: unknown) => {
        const log = ctx.log.child({ tool: def.name })
        const started = performance.now()
        const result = await run(def, args as z.output<In>, ctx)
        const durationMs = Math.round(performance.now() - started)
        return result.match(
          (value) => {
            log.info({ durationMs }, 'tool ok')
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(value) }],
              structuredContent: value as Record<string, unknown>,
            }
          },
          (e) => {
            log.warn({ durationMs, errorTag: e.tag, error: e.message }, 'tool error')
            return {
              content: [{ type: 'text' as const, text: renderToolError(e) }],
              isError: true,
            }
          },
        )
      },
    )
  },
})

const run = async <In extends z.ZodObject, Out extends z.ZodObject>(
  def: ToolDef<In, Out>,
  args: z.output<In>,
  ctx: ToolCtx,
): Promise<Result<z.output<Out>, ChainError>> => {
  try {
    return await def.handler(args, ctx)
  } catch (e) {
    ctx.log.error({ tool: def.name, err: e }, 'tool handler panicked')
    return err(internalError('unexpected failure in tool handler'))
  }
}
