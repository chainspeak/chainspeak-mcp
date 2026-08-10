import { okAsync, ResultAsync } from 'neverthrow'
import * as z from 'zod'
import { decodeMethod, decodeTokenEvents, splitRevertWords } from '../chain/decode'
import type { ChainError } from '../chain/errors'
import { scaleUnits, weiToGwei } from '../chain/format'
import type { ChainReader } from '../chain/reader'
import { type Address, HashSchema, type PinnedBlock, type TransactionData } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'

const input = z.object({
  tx_hash: HashSchema.describe(
    '0x-prefixed 32-byte transaction hash, e.g. 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
  ),
  detail: z
    .enum(['summary', 'full', 'raw'])
    .default('summary')
    .describe(
      'summary (default): everything except logs and calldata; full: adds the raw event logs; raw: adds the untouched eth_getTransactionByHash/eth_getTransactionReceipt payloads',
    ),
})

const tokenAmount = {
  amount_raw: z.string().nullable(),
  amount_formatted: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().nullable(),
}

const tokenTransfer = z.object({
  standard: z.enum(['erc20', 'erc721']),
  token: z.string(),
  from: z.string(),
  to: z.string(),
  ...tokenAmount,
  token_id: z.string().nullable(),
  log_index: z.number(),
})

const tokenApproval = z.object({
  standard: z.enum(['erc20', 'erc721']),
  event: z.enum(['approval', 'approval_for_all']),
  token: z.string(),
  owner: z.string(),
  spender: z.string(),
  ...tokenAmount,
  token_id: z.string().nullable(),
  approved: z.boolean().nullable(),
  log_index: z.number(),
})

const logEntry = z.object({
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
  log_index: z.number(),
})

const output = z.object({
  chain_id: z.string(),
  /** the head this answer was computed against — NOT the block holding the tx */
  chain_head: z.string(),
  found: z.boolean(),
  hash: z.string(),
  status: z.enum(['success', 'failed', 'pending']).nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  created_contract: z.string().nullable(),
  value_wei: z.string().nullable(),
  value_native: z.string().nullable(),
  native_symbol: z.string(),
  nonce: z.number().nullable(),
  tx_type: z.string().nullable(),
  gas_limit: z.string().nullable(),
  method: z.object({ selector: z.string(), name: z.string().nullable() }).nullable(),
  receipt: z
    .object({
      included_in_block: z.string(),
      confirmations: z.string(),
      gas_used: z.string(),
      gas_used_percent: z.string().nullable(),
      log_count: z.number(),
    })
    .nullable(),
  fees: z
    .object({
      total_wei: z.string(),
      total_native: z.string(),
      execution_wei: z.string().nullable(),
      blob_wei: z.string().nullable(),
      effective_gas_price_wei: z.string().nullable(),
      effective_gas_price_gwei: z.string().nullable(),
      max_fee_per_gas_wei: z.string().nullable(),
      max_priority_fee_per_gas_wei: z.string().nullable(),
    })
    .nullable(),
  blob: z
    .object({
      gas_used: z.string(),
      gas_price_wei: z.string(),
      max_fee_per_blob_gas_wei: z.string().nullable(),
      versioned_hashes: z.array(z.string()),
    })
    .nullable(),
  authorization_list: z
    .array(z.object({ chain_id: z.string(), address: z.string(), nonce: z.string() }))
    .nullable(),
  token_transfers: z.array(tokenTransfer).nullable(),
  token_approvals: z.array(tokenApproval).nullable(),
  failure: z
    .object({
      reason: z.string().nullable(),
      revert_data: z.string().nullable(),
      revert_data_words: z
        .array(
          z.object({
            hex: z.string(),
            uint256: z.string(),
            address: z.string().nullable(),
          }),
        )
        .nullable(),
      method: z.enum(['trace', 'replay', 'none']),
      confidence: z.enum(['exact', 'approximate', 'none']),
      method_note: z.string().nullable(),
    })
    .nullable(),
  logs: z.array(logEntry).nullable(),
  raw_transaction: z.unknown().nullable(),
  raw_receipt: z.unknown().nullable(),
  note: z.string().nullable(),
})

type Out = z.output<typeof output>

const notFoundOut = (
  chainId: bigint,
  head: PinnedBlock,
  hash: string,
  native: { symbol: string; decimals: number },
): Out => ({
  chain_id: chainId.toString(),
  chain_head: head.number.toString(),
  found: false,
  hash,
  status: null,
  from: null,
  to: null,
  created_contract: null,
  value_wei: null,
  value_native: null,
  native_symbol: native.symbol,
  nonce: null,
  tx_type: null,
  gas_limit: null,
  method: null,
  receipt: null,
  fees: null,
  blob: null,
  authorization_list: null,
  token_transfers: null,
  token_approvals: null,
  failure: null,
  logs: null,
  raw_transaction: null,
  raw_receipt: null,
  note: 'transaction not found — the node does not know this hash; it may never have existed, may have been dropped from the mempool, or may be on a different chain',
})

const gasUsedPercent = (gasUsed: bigint, gasLimit: bigint): string | null => {
  if (gasLimit === 0n) return null
  return (Number((gasUsed * 10000n) / gasLimit) / 100).toFixed(2)
}

const APPROVAL_EVENTS = new Set(['approval', 'approval_for_all'])

const mapTx = (
  chainId: bigint,
  head: PinnedBlock,
  tx: TransactionData,
  detail: 'summary' | 'full' | 'raw',
  native: { symbol: string; decimals: number },
): Out => {
  const executionFeeWei =
    tx.gasUsed !== null && tx.effectiveGasPriceWei !== null
      ? tx.gasUsed * tx.effectiveGasPriceWei
      : null
  // EIP-4844 blob gas is priced in its own market; for a rollup batch poster it
  // IS the bill, so a total that drops it is wrong, not merely imprecise.
  const blobFeeWei =
    tx.blobGasUsed !== null && tx.blobGasPriceWei !== null
      ? tx.blobGasUsed * tx.blobGasPriceWei
      : null
  const totalWei =
    executionFeeWei === null && blobFeeWei === null
      ? null
      : (executionFeeWei ?? 0n) + (blobFeeWei ?? 0n)

  const events = tx.logs === null ? null : decodeTokenEvents(tx.logs)
  const blank = { amount_formatted: null, symbol: null, decimals: null }

  return {
    chain_id: chainId.toString(),
    chain_head: head.number.toString(),
    found: true,
    hash: tx.hash,
    status: tx.status,
    from: tx.from,
    to: tx.to,
    created_contract: tx.createdContract,
    value_wei: tx.valueWei.toString(),
    value_native: scaleUnits(tx.valueWei, native.decimals),
    native_symbol: native.symbol,
    nonce: tx.nonce,
    tx_type: tx.txType,
    gas_limit: tx.gasLimit.toString(),
    method: decodeMethod(tx.input),
    receipt:
      tx.blockNumber === null || tx.gasUsed === null
        ? null
        : {
            included_in_block: tx.blockNumber.toString(),
            confirmations: (head.number - tx.blockNumber + 1n).toString(),
            gas_used: tx.gasUsed.toString(),
            gas_used_percent: gasUsedPercent(tx.gasUsed, tx.gasLimit),
            log_count: tx.logs?.length ?? 0,
          },
    fees:
      totalWei === null
        ? null
        : {
            total_wei: totalWei.toString(),
            total_native: scaleUnits(totalWei, native.decimals),
            execution_wei: executionFeeWei === null ? null : executionFeeWei.toString(),
            blob_wei: blobFeeWei === null ? null : blobFeeWei.toString(),
            effective_gas_price_wei:
              tx.effectiveGasPriceWei === null ? null : tx.effectiveGasPriceWei.toString(),
            effective_gas_price_gwei:
              tx.effectiveGasPriceWei === null ? null : weiToGwei(tx.effectiveGasPriceWei),
            max_fee_per_gas_wei: tx.maxFeePerGasWei === null ? null : tx.maxFeePerGasWei.toString(),
            max_priority_fee_per_gas_wei:
              tx.maxPriorityFeePerGasWei === null ? null : tx.maxPriorityFeePerGasWei.toString(),
          },
    blob:
      tx.blobGasUsed === null || tx.blobGasPriceWei === null
        ? null
        : {
            gas_used: tx.blobGasUsed.toString(),
            gas_price_wei: tx.blobGasPriceWei.toString(),
            max_fee_per_blob_gas_wei:
              tx.maxFeePerBlobGasWei === null ? null : tx.maxFeePerBlobGasWei.toString(),
            versioned_hashes: [...(tx.blobVersionedHashes ?? [])],
          },
    authorization_list:
      (tx.authorizationList ?? null) === null
        ? null
        : (tx.authorizationList ?? []).map((a) => ({
            chain_id: a.chainId,
            address: a.address,
            nonce: a.nonce,
          })),
    // Approvals move nothing, so they are kept out of token_transfers entirely:
    // summing a mixed array to get "value moved" double-counts every approval.
    token_transfers:
      events === null
        ? null
        : events
            .filter((e) => !APPROVAL_EVENTS.has(e.event))
            .map((e) => ({
              standard: e.standard,
              token: e.token,
              from: e.from,
              to: e.to,
              amount_raw: e.amount_raw,
              token_id: e.token_id,
              log_index: e.log_index,
              ...blank,
            })),
    token_approvals:
      events === null
        ? null
        : events
            .filter((e) => APPROVAL_EVENTS.has(e.event))
            .map((e) => ({
              standard: e.standard,
              event:
                e.event === 'approval_for_all'
                  ? ('approval_for_all' as const)
                  : ('approval' as const),
              token: e.token,
              owner: e.from,
              spender: e.to,
              amount_raw: e.amount_raw,
              token_id: e.token_id,
              approved: e.approved,
              log_index: e.log_index,
              ...blank,
            })),
    failure: null,
    logs:
      detail === 'summary' || tx.logs === null
        ? null
        : tx.logs.map((l) => ({
            address: l.address,
            topics: [...l.topics],
            data: l.data,
            log_index: l.logIndex,
          })),
    raw_transaction: null,
    raw_receipt: null,
    note: null,
  }
}

/** Cap on distinct tokens we will look up, so a fat transaction cannot fan out. */
const MAX_TOKEN_LOOKUPS = 8

/**
 * Turn raw token amounts into readable ones. Costs one metadata read per DISTINCT
 * token, which beats making the caller issue a second tool call per amount.
 * Never fails the transaction: unknown metadata simply stays null.
 */
const enrichTokens = (r: ChainReader, atBlock: bigint, out: Out): ResultAsync<Out, ChainError> => {
  const rows = [...(out.token_transfers ?? []), ...(out.token_approvals ?? [])]
  const tokens = [...new Set(rows.map((e) => e.token))].slice(0, MAX_TOKEN_LOOKUPS)
  if (tokens.length === 0) return okAsync(out)

  return ResultAsync.combine(
    tokens.map((token) =>
      r
        .tokenInfo(token as Address, atBlock)
        .map((info) => [token, info] as const)
        .orElse(() => okAsync([token, null] as const)),
    ),
  ).map((pairs) => {
    const meta = new Map(pairs)
    const fill = <T extends { token: string; amount_raw: string | null }>(row: T): T => {
      const info = meta.get(row.token) ?? null
      if (info === null) return row
      return {
        ...row,
        symbol: info.symbol,
        decimals: info.decimals,
        amount_formatted:
          row.amount_raw === null || info.decimals === null
            ? null
            : scaleUnits(BigInt(row.amount_raw), info.decimals),
      }
    }
    return {
      ...out,
      token_transfers: out.token_transfers?.map(fill) ?? null,
      token_approvals: out.token_approvals?.map(fill) ?? null,
    }
  })
}

export const transactionHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r, spec }) =>
    r.chainId().andThen((chainId) =>
      r.pinBlock('latest').andThen((head) =>
        r.transaction(args.tx_hash).andThen((tx) => {
          if (tx === null) return okAsync(notFoundOut(chainId, head, args.tx_hash, spec.native))
          const base = mapTx(chainId, head, tx, args.detail, spec.native)
          const withFailure =
            tx.status === 'failed'
              ? r.analyzeFailure(tx).map(
                  (f): Out => ({
                    ...base,
                    failure: {
                      reason: f.reason,
                      revert_data: f.revertData,
                      revert_data_words:
                        f.revertData === null ? null : splitRevertWords(f.revertData),
                      method: f.method,
                      confidence: f.confidence,
                      method_note: f.note,
                    },
                  }),
                )
              : okAsync(base)
          return withFailure
            .andThen((out) => enrichTokens(r, head.number, out))
            .andThen((out) => {
              if (args.detail !== 'raw') return okAsync(out)
              return r.transactionRaw(args.tx_hash).map(
                (raw): Out => ({
                  ...out,
                  raw_transaction: raw?.transaction ?? null,
                  raw_receipt: raw?.receipt ?? null,
                }),
              )
            })
        }),
      ),
    ),
  )

export const getTransaction = defineTool({
  name: 'chainspeak_get_transaction',
  description:
    'Everything about a transaction by hash: status (success|failed|pending), from, to (null for contract creation, with created_contract carrying the deployed address), transferred value in wei and ether, nonce, tx_type, gas_limit AND gas_used with gas_used_percent (out-of-gas shows near 100% on a failed tx), effective gas price in wei and gwei, the EIP-1559 fee caps, the total fee_paid precomputed in wei and ether, the block it was included in plus confirmations, and the number of logs it emitted. method decodes the calldata selector against a small bundled set of common ERC-20/721 functions (name null = outside the set, method null = plain value transfer). token_transfers decodes ERC-20/721 Transfer and Approval events from bundled ABIs — other events are skipped, not errors. A FAILED transaction additionally carries failure: {reason, revert_data, method, confidence, method_note} explaining why it reverted — method "trace" (confidence exact) uses debug_traceTransaction when the RPC endpoint offers it, method "replay" (confidence approximate) re-runs the call against top-of-block state, so order-dependent failures may honestly report "could not reproduce" (confidence none); method_note is non-null whenever a better method was expected but unavailable at call time (e.g. trace probed available but the trace call failed — retrying may reach it); standard Error(string) and Panic reasons are decoded, custom errors come back as raw selector + data, with revert_data_words splitting the arguments into 32-byte words read as uint256 (and as an address where the word is one) so amounts are legible without the ABI. detail controls size: summary (default) omits logs and calldata, full adds raw event logs, raw adds the untouched RPC payloads. Wraps eth_getTransactionByHash and eth_getTransactionReceipt. Every response echoes chain_id and block_number (the chain head the answer was computed against — the basis for confirmations); addresses are EIP-55 checksummed. A pending transaction has status "pending" and null receipt fields. found false with an explanatory note means the node does not know the hash — a normal answer, not an error.',
  input,
  output,
  idempotent: false,
  handler: transactionHandler,
})
