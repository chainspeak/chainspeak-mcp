import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { getAddress } from 'viem'
import * as z from 'zod'
import { addressTopic, decodeTokenEvent, EVENT_TOPICS } from '../chain/decode'
import { type ChainError, invalidInput } from '../chain/errors'
import {
  type Address,
  AddressOrNameSchema,
  AddressSchema,
  BlockRefSchema,
  type LogFilter,
  type RangeLog,
} from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'
import { resolveAddressInput } from '../mcp/ens'

const input = z.object({
  kind: z
    .enum(['transfers', 'approvals', 'raw'])
    .describe(
      'transfers: ERC-20/721 Transfer events where `address` is sender or receiver; approvals: Approval/ApprovalForAll events where `address` is the owner; raw: filter only by emitted_by and/or topics',
    ),
  address: AddressOrNameSchema.optional().describe(
    'the account the transfers/approvals concern (0x address or ENS name); omit it with a token set to get ALL transfers/approvals of that contract; ignored for raw',
  ),
  token: AddressSchema.optional().describe(
    'optional for transfers/approvals: restrict to events emitted by this token contract',
  ),
  emitted_by: AddressSchema.optional().describe(
    'raw: the contract whose events to list (required for raw unless topics are given)',
  ),
  topics: z
    .array(
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, 'each topic is a 32-byte 0x-hex word')
        .nullable(),
    )
    .max(4)
    .optional()
    .describe(
      'raw power use: positional topic filter as in eth_getLogs (index 0 = event signature hash; null = wildcard at that position)',
    ),
  from_block: BlockRefSchema.describe(
    'start of the block range (inclusive): tag, decimal, or 0x-hex number — required; ranges are capped per chain (see the error if you exceed it)',
  ),
  to_block: BlockRefSchema.default('latest').describe(
    'end of the block range (inclusive): tag, decimal, or 0x-hex number; default latest',
  ),
  limit: z.int().min(1).max(200).default(50).describe('page size, 1-200; default 50'),
  cursor: z
    .string()
    .regex(/^\d+$/, 'cursor is the opaque string from a previous response, e.g. "50"')
    .optional()
    .describe('continuation cursor from the previous page (pagination.next_cursor)'),
})

const eventItem = z.object({
  block_number: z.string(),
  tx_hash: z.string(),
  log_index: z.number(),
  emitted_by: z.string(),
  decoded: z.boolean(),
  event: z.enum(['transfer', 'approval', 'approval_for_all']).nullable(),
  standard: z.enum(['erc20', 'erc721']).nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  amount_raw: z.string().nullable(),
  token_id: z.string().nullable(),
  approved: z.boolean().nullable(),
  topic0: z.string().nullable(),
  topics: z.array(z.string()).nullable(),
  data: z.string().nullable(),
})

const pagination = z.object({
  offset: z.number(),
  limit: z.number(),
  returned: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  message: z.string().nullable(),
})

const output = z.object({
  chain_id: z.string(),
  block_number: z.string(),
  from_block: z.string(),
  to_block: z.string(),
  resolved_address: z.string().nullable(),
  events: z.array(eventItem),
  pagination,
})

type Out = z.output<typeof output>
type EventItem = z.output<typeof eventItem>

const toItem = (log: RangeLog): EventItem => {
  const decoded = decodeTokenEvent(log)
  const base = {
    block_number: log.blockNumber.toString(),
    tx_hash: log.txHash,
    log_index: log.logIndex,
    emitted_by: log.address,
    topic0: log.topics[0] ?? null,
  }
  if (decoded !== null) {
    return {
      ...base,
      decoded: true,
      event: decoded.event,
      standard: decoded.standard,
      from: decoded.from,
      to: decoded.to,
      amount_raw: decoded.amount_raw,
      token_id: decoded.token_id,
      approved: decoded.approved,
      topics: null,
      data: null,
    }
  }
  return {
    ...base,
    decoded: false,
    event: null,
    standard: null,
    from: null,
    to: null,
    amount_raw: null,
    token_id: null,
    approved: null,
    topics: [...log.topics],
    data: log.data,
  }
}

/** Block counts mean different spans per chain, so say it in time when we can. */
const spanInTime = (spec: { maxLogRange: bigint; blockTimeSec: number | null }): string => {
  if (spec.blockTimeSec === null) return ''
  const hours = (Number(spec.maxLogRange) * spec.blockTimeSec) / 3600
  return ` (about ${hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`})`
}

const buildFilters = (
  args: z.output<typeof input>,
  address: Address | null,
  fromBlock: bigint,
  toBlock: bigint,
): ResultAsync<LogFilter[], ChainError> => {
  const emittedBy = args.kind === 'raw' ? args.emitted_by : args.token
  const withRange = (topics: LogFilter['topics']): LogFilter => ({
    ...(emittedBy !== undefined ? { address: emittedBy } : {}),
    ...(topics !== undefined ? { topics } : {}),
    fromBlock,
    toBlock,
  })
  if (args.kind === 'transfers') {
    if (address === null && emittedBy === undefined) {
      return errAsync(
        invalidInput(
          'kind "transfers" needs an address and/or a token',
          'pass address (0x or ENS name) for the transfers of an account, token for all transfers of a contract, or both to combine',
        ),
      )
    }
    if (address === null) {
      // all Transfer events of the token, any parties
      return okAsync([withRange([EVENT_TOPICS.transfer])])
    }
    const addr = addressTopic(address)
    return okAsync([
      withRange([EVENT_TOPICS.transfer, addr]), // address as sender
      withRange([EVENT_TOPICS.transfer, null, addr]), // address as receiver
    ])
  }
  if (args.kind === 'approvals') {
    if (address === null && emittedBy === undefined) {
      return errAsync(
        invalidInput(
          'kind "approvals" needs an address and/or a token',
          'pass address (0x or ENS name) for the approvals granted by an owner, token for all approvals on a contract, or both to combine',
        ),
      )
    }
    if (address === null) {
      return okAsync([withRange([[EVENT_TOPICS.approval, EVENT_TOPICS.approvalForAll]])])
    }
    const addr = addressTopic(address)
    return okAsync([withRange([[EVENT_TOPICS.approval, EVENT_TOPICS.approvalForAll], addr])])
  }
  if (args.emitted_by === undefined && args.topics === undefined) {
    return errAsync(
      invalidInput(
        'kind "raw" with neither emitted_by nor topics would query every event on the chain',
        'pass emitted_by (a contract address), topics, or use the transfers/approvals presets',
      ),
    )
  }
  return okAsync([withRange(args.topics as LogFilter['topics'])])
}

export const eventsHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r, spec }) =>
    r.chainId().andThen((chainId) =>
      r.pinBlock(args.from_block).andThen((fromPin) =>
        r.pinBlock(args.to_block).andThen((toPin) => {
          if (fromPin.number > toPin.number) {
            return errAsync(
              invalidInput(
                `from_block (${fromPin.number}) is after to_block (${toPin.number})`,
                'swap the bounds — from_block must not be greater than to_block',
              ),
            )
          }
          const span = toPin.number - fromPin.number + 1n
          const maxRange = spec.maxLogRange
          if (span > maxRange) {
            return errAsync(
              invalidInput(
                `block range of ${span} blocks exceeds the maximum of ${maxRange} on ${spec.key}`,
                `narrow the range to at most ${maxRange} blocks${spanInTime(spec)} (e.g. from_block ${toPin.number - maxRange + 1n} to_block ${toPin.number}) and page through ranges`,
              ),
            )
          }
          const givenAddress = args.kind === 'raw' ? undefined : args.address
          return (
            givenAddress !== undefined
              ? resolveAddressInput(ctx, args.chain, givenAddress, toPin).map(
                  (res): Address | null => res.address.toLowerCase() as Address,
                )
              : okAsync<Address | null, ChainError>(null)
          ).andThen((address) =>
            buildFilters(args, address, fromPin.number, toPin.number).andThen((filters) =>
              ResultAsync.combine(filters.map((f) => r.getLogs(f))).map((results) => {
                const seen = new Set<string>()
                const merged: RangeLog[] = []
                for (const log of results.flat()) {
                  const key = `${log.blockNumber}-${log.logIndex}`
                  if (seen.has(key)) continue
                  seen.add(key)
                  merged.push(log)
                }
                merged.sort((a, b) =>
                  a.blockNumber === b.blockNumber
                    ? a.logIndex - b.logIndex
                    : a.blockNumber < b.blockNumber
                      ? -1
                      : 1,
                )
                const offset = args.cursor === undefined ? 0 : Number(args.cursor)
                const slice = merged.slice(offset, offset + args.limit)
                const nextOffset = offset + args.limit
                const next = nextOffset < merged.length ? String(nextOffset) : null
                return {
                  chain_id: chainId.toString(),
                  block_number: toPin.number.toString(),
                  from_block: fromPin.number.toString(),
                  to_block: toPin.number.toString(),
                  resolved_address: address === null ? null : getAddress(address),
                  events: slice.map(toItem),
                  pagination: {
                    offset,
                    limit: args.limit,
                    returned: slice.length,
                    has_more: next !== null,
                    next_cursor: next,
                    message:
                      next === null
                        ? null
                        : `showing events ${offset + 1}-${offset + slice.length} in blocks ${fromPin.number}-${toPin.number}; pass cursor "${next}" to continue, or narrow the block range`,
                  },
                }
              }),
            ),
          )
        }),
      ),
    ),
  )

export const getEvents = defineTool({
  name: 'chainspeak_get_events',
  description:
    'What events matching a filter happened in a block range — contract event logs via eth_getLogs, shaped by presets: kind "transfers" lists ERC-20/721 Transfer events where address (0x or ENS) is the sender or receiver — or, with token set and address omitted, ALL Transfer events of that contract; kind "approvals" works the same for Approval/ApprovalForAll events with address as the owner; kind "raw" takes emitted_by (a contract) and/or a positional topics filter for anything else. Results are a page, not a count: pagination reports has_more and next_cursor rather than a total, because totalling a range means fetching every match in it. Transfer and Approval events are decoded from bundled ABIs; every other event comes back with decoded false plus its raw topic0, topics, and data — visible but not interpreted, since naming arbitrary events requires contract ABIs this server does not fetch. The block range is required and capped at 10000 blocks; results are paginated (limit, default 50; continue with pagination.next_cursor) and truncation is always announced, never silent. Physics note: native ETH transfers are not events and will NOT appear here — only contract-emitted logs do; for one transaction\'s events use chainspeak_get_transaction detail full instead. Every response echoes chain_id, block_number (the resolved to_block), and the resolved range; addresses are EIP-55 checksummed. An empty events list is a normal answer, not an error.',
  input,
  output,
  idempotent: false,
  handler: eventsHandler,
})
