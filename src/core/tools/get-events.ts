import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
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
    'start of the block range (inclusive): tag, decimal, or 0x-hex number — required. Ask for the range you actually care about: there is no cap, and the server walks wide ranges in provider-sized windows for you.',
  ),
  to_block: BlockRefSchema.default('latest').describe(
    'end of the block range (inclusive): tag, decimal, or 0x-hex number; default latest',
  ),
  limit: z.int().min(1).max(200).default(50).describe('page size, 1-200; default 50'),
  cursor: z
    .string()
    .optional()
    .describe(
      'continuation cursor from the previous page (pagination.next_cursor), passed back verbatim. Keep the SAME from_block/to_block when you continue — the cursor carries the position within them.',
    ),
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
  /** how far through the requested range the server actually walked */
  scanned_through: z.string(),
  /** the window size the provider accepted, in blocks — measured, not assumed */
  window_blocks: z.string(),
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

/**
 * A cursor is `<block>:<logIndex>` — resume at that block, skipping logs there
 * up to and including that index. `-1` means skip nothing, which is how a page
 * that ran out of scanned blocks without filling up points at the next block.
 */
const parseCursor = (
  cursor: string | undefined,
): { block: bigint; logIndex: number } | null | 'invalid' => {
  if (cursor === undefined) return null
  const m = /^(\d+):(-?\d+)$/.exec(cursor)
  if (m?.[1] === undefined || m[2] === undefined) return 'invalid'
  return { block: BigInt(m[1]), logIndex: Number(m[2]) }
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
          // No range cap. The old one refused anything over 10,000 blocks — a
          // number the provider had never agreed to (drpc refused 10,000 and
          // accepted 4,883) and one that made L2s unusable: 10,000 Arbitrum
          // blocks is about 42 minutes, so finding a single event in a
          // four-month window meant roughly 3,400 caller-orchestrated calls.
          // Ask for the range you want; the walk below adapts to the provider.
          const resume = parseCursor(args.cursor)
          if (resume === 'invalid') {
            return errAsync(
              invalidInput(
                `cursor ${JSON.stringify(args.cursor)} is not a cursor this server issued`,
                'pass pagination.next_cursor from the previous response verbatim, or omit cursor to start the range again',
              ),
            )
          }
          const scanFrom = resume === null ? fromPin.number : resume.block
          const givenAddress = args.kind === 'raw' ? undefined : args.address
          return (
            givenAddress !== undefined
              ? resolveAddressInput(ctx, args.chain, givenAddress, toPin).map(
                  (res): Address | null => res.address.toLowerCase() as Address,
                )
              : okAsync<Address | null, ChainError>(null)
          ).andThen((address) =>
            buildFilters(args, address, scanFrom, toPin.number).andThen((filters) =>
              r
                .scanLogs(filters, { stopAfter: args.limit, windowHint: spec.maxLogRange })
                .map((scan) => {
                  // Drop anything the previous page already returned. Anchoring
                  // the cursor to (block, logIndex) rather than an offset is what
                  // lets a page be answered without scanning the whole range.
                  const fresh =
                    resume === null
                      ? scan.logs
                      : scan.logs.filter(
                          (l) =>
                            l.blockNumber > resume.block ||
                            (l.blockNumber === resume.block && l.logIndex > resume.logIndex),
                        )
                  const slice = fresh.slice(0, args.limit)
                  const last = slice[slice.length - 1]
                  const moreInScan = fresh.length > slice.length
                  const rangeLeft = scan.scannedTo < toPin.number
                  const hasMore = moreInScan || rangeLeft
                  // Two ways a page ends: full (resume after the last event) or
                  // out of scanned blocks with room to spare (resume where the
                  // walk stopped). The second is why an empty page can still
                  // legitimately say has_more.
                  const next = !hasMore
                    ? null
                    : moreInScan && last !== undefined
                      ? `${last.blockNumber}:${last.logIndex}`
                      : `${scan.scannedTo + 1n}:-1`
                  return {
                    chain_id: chainId.toString(),
                    block_number: toPin.number.toString(),
                    from_block: fromPin.number.toString(),
                    to_block: toPin.number.toString(),
                    resolved_address: address === null ? null : getAddress(address),
                    events: slice.map(toItem),
                    pagination: {
                      scanned_through: scan.scannedTo.toString(),
                      window_blocks: scan.windowUsed.toString(),
                      limit: args.limit,
                      returned: slice.length,
                      has_more: hasMore,
                      next_cursor: next,
                      message:
                        next === null
                          ? null
                          : `returned ${slice.length} event(s) from blocks ${scanFrom}-${scan.scannedTo} of the requested ${fromPin.number}-${toPin.number}; pass cursor "${next}" to continue. The range is walked in ${scan.windowUsed}-block windows server-side — you do not need to narrow it yourself.`,
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
    'What events matching a filter happened in a block range — contract event logs via eth_getLogs, shaped by presets: kind "transfers" lists ERC-20/721 Transfer events where address (0x or ENS) is the sender or receiver — or, with token set and address omitted, ALL Transfer events of that contract; kind "approvals" works the same for Approval/ApprovalForAll events with address as the owner; kind "raw" takes emitted_by (a contract) and/or a positional topics filter for anything else. Results are a page, not a count: pagination reports has_more and next_cursor rather than a total, because totalling a range means fetching every match in it. Transfer and Approval events are decoded from bundled ABIs; every other event comes back with decoded false plus its raw topic0, topics, and data — visible but not interpreted, since naming arbitrary events requires contract ABIs this server does not fetch. The block range is required but NOT capped: ask for the range you actually care about (a whole month on an L2 is fine) and the server walks it in windows the provider accepts, adapting when it refuses one, so you never have to guess or discover the limit by failing. Results are paginated (limit, default 50): keep the same from_block/to_block and pass pagination.next_cursor back verbatim. Read pagination.has_more, not the event count — a page can come back short, or even empty, while has_more is true, because the walk stops when the page is full OR when it has scanned far enough; pagination.scanned_through tells you how far it got and window_blocks is the window the provider actually accepted. Truncation is always announced, never silent. Physics note: native ETH transfers are not events and will NOT appear here — only contract-emitted logs do; for one transaction\'s events use chainspeak_get_transaction detail full instead. Every response echoes chain_id, block_number (the resolved to_block), and the resolved range; addresses are EIP-55 checksummed. An empty events list is a normal answer, not an error.',
  input,
  output,
  idempotent: false,
  handler: eventsHandler,
})
