import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import * as z from 'zod'
import { type ChainError, notFound } from '../chain/errors'
import { scaleUnits, weiToGwei } from '../chain/format'
import { BlockRefSchema, type GasOutlook } from '../chain/types'
import { defineTool, type ToolArgs, type ToolCtx } from '../mcp/define-tool'

const SIMPLE_TRANSFER_GAS = 21000n

const input = z.object({
  block: BlockRefSchema.default('latest').describe(
    'optional historical block (tag, decimal, or 0x-hex number) — the gas tiers and transfer estimate are current-only and come back null for a historical block; default latest',
  ),
})

const tier = z.object({
  name: z.enum(['slow', 'standard', 'fast']),
  priority_fee_wei: z.string(),
  priority_fee_gwei: z.string(),
  total_fee_per_gas_wei: z.string(),
  total_fee_per_gas_gwei: z.string(),
})

const output = z.object({
  chain_id: z.string(),
  block_number: z.string(),
  chain_name: z.string(),
  native_symbol: z.string(),
  block_timestamp_unix: z.string(),
  block_timestamp_iso: z.string(),
  base_fee_wei: z.string().nullable(),
  base_fee_gwei: z.string().nullable(),
  gas_tiers: z.array(tier).nullable(),
  simple_transfer_cost: z
    .object({
      gas: z.string(),
      tier: z.string(),
      fee_wei: z.string(),
      fee_native: z.string(),
      l1_breakdown: z.object({ l2_fee_wei: z.string(), l1_data_fee_wei: z.string() }).nullable(),
    })
    .nullable(),
  blob_base_fee_wei: z.string().nullable(),
  l1_data_fee_wei: z.string().nullable(),
  upstream_syncing: z.boolean(),
  upstream: z.object({
    trace: z.boolean().nullable(),
    batch_cap: z.number().nullable(),
  }),
  note: z.string().nullable(),
})

type Out = z.output<typeof output>

const tiers = (
  baseFee: bigint | null,
  outlook: GasOutlook,
  decimals: number,
  l1DataFee: boolean,
  l1FeeWei: bigint | null,
): { gas_tiers: Out['gas_tiers']; simple_transfer_cost: Out['simple_transfer_cost'] } => {
  if (outlook.priorityTiersWei === null || baseFee === null) {
    return { gas_tiers: null, simple_transfer_cost: null }
  }
  const mk = (name: 'slow' | 'standard' | 'fast', priority: bigint): z.output<typeof tier> => ({
    name,
    priority_fee_wei: priority.toString(),
    priority_fee_gwei: weiToGwei(priority),
    total_fee_per_gas_wei: (baseFee + priority).toString(),
    total_fee_per_gas_gwei: weiToGwei(baseFee + priority),
  })
  const standardTotal = (baseFee + outlook.priorityTiersWei.standard) * SIMPLE_TRANSFER_GAS
  const gas_tiers = [
    mk('slow', outlook.priorityTiersWei.slow),
    mk('standard', outlook.priorityTiersWei.standard),
    mk('fast', outlook.priorityTiersWei.fast),
  ]
  // On OP-stack chains the L1 data fee dominates. Include it when we have it;
  // omit the estimate entirely when we do not, because a number missing the
  // dominant component is wrong rather than merely imprecise.
  if (l1DataFee && l1FeeWei === null) return { gas_tiers, simple_transfer_cost: null }
  const total = standardTotal + (l1FeeWei ?? 0n)
  return {
    gas_tiers,
    simple_transfer_cost: {
      gas: SIMPLE_TRANSFER_GAS.toString(),
      tier: 'standard',
      fee_wei: total.toString(),
      fee_native: scaleUnits(total, decimals),
      l1_breakdown:
        l1FeeWei === null
          ? null
          : { l2_fee_wei: standardTotal.toString(), l1_data_fee_wei: l1FeeWei.toString() },
    },
  }
}

const statusNote = (
  syncing: boolean,
  l1DataFee: boolean,
  label: string,
  l1FeeWei: bigint | null,
): string | null => {
  const parts: string[] = []
  if (syncing) {
    parts.push(
      'the upstream RPC node reports it is still syncing — answers may lag the real chain head',
    )
  }
  if (l1DataFee) {
    parts.push(
      l1FeeWei === null
        ? `${label} charges an L1 data fee on top of L2 gas which usually dominates the total, and it could not be read here — simple_transfer_cost is omitted rather than reported too low; the gas tiers cover the L2 portion only`
        : `${label} charges an L1 data fee on top of L2 gas; simple_transfer_cost includes it (see l1_data_fee_wei), while the gas tiers cover the L2 portion only`,
    )
  }
  return parts.length === 0 ? null : parts.join('; ')
}

export const chainStatusHandler = (
  args: ToolArgs<typeof input>,
  ctx: ToolCtx,
): ResultAsync<Out, ChainError> =>
  ctx.resolve(args.chain).asyncAndThen(({ reader: r, spec }) =>
    r.chainId().andThen((chainId) =>
      ResultAsync.combine([r.capabilities(), r.block(args.block, { fullTxs: false })]).andThen(
        ([caps, b]) => {
          if (b === null) {
            return errAsync(
              notFound(
                `block ${String(args.block)} does not exist on this chain`,
                'the block number is beyond the current head — use an existing block number, or omit the block parameter for the current status',
              ),
            )
          }
          const historical = args.block !== 'latest'
          const base = {
            chain_id: chainId.toString(),
            block_number: b.number.toString(),
            chain_name: spec.label,
            native_symbol: spec.native.symbol,
            block_timestamp_unix: b.timestamp.toString(),
            block_timestamp_iso: new Date(Number(b.timestamp) * 1000).toISOString(),
            base_fee_wei: b.baseFeePerGasWei === null ? null : b.baseFeePerGasWei.toString(),
            base_fee_gwei: b.baseFeePerGasWei === null ? null : weiToGwei(b.baseFeePerGasWei),
            upstream: { trace: caps.trace, batch_cap: caps.batchCap },
          }
          if (historical) {
            return okAsync({
              ...base,
              gas_tiers: null,
              simple_transfer_cost: null,
              blob_base_fee_wei: null,
              l1_data_fee_wei: null,
              upstream_syncing: false,
              note: 'historical block: base fee is from that block; gas tiers, blob fee, and the transfer estimate are current-only and omitted',
            })
          }
          return ResultAsync.combine([r.gasOutlook(), r.l1DataFee()]).map(
            ([outlook, l1FeeWei]): Out => ({
              ...base,
              ...tiers(
                b.baseFeePerGasWei,
                outlook,
                spec.native.decimals,
                spec.features.l1DataFee,
                l1FeeWei,
              ),
              blob_base_fee_wei:
                outlook.blobBaseFeeWei === null ? null : outlook.blobBaseFeeWei.toString(),
              upstream_syncing: outlook.syncing,
              l1_data_fee_wei: l1FeeWei === null ? null : l1FeeWei.toString(),
              note: statusNote(outlook.syncing, spec.features.l1DataFee, spec.label, l1FeeWei),
            }),
          )
        },
      ),
    ),
  )

export const getChainStatus = defineTool({
  name: 'chainspeak_get_chain_status',
  description:
    'Where the chain is right now, in one call: chain id + human chain_name (identifies which network the RPC endpoint serves), the latest block (number echoed in block_number, timestamp as unix string and ISO), the base fee, priority-fee tiers (slow/standard/fast, averaged from recent fee history) each with the resulting total price per gas, a precomputed simple_transfer_cost ("a plain ETH transfer costs ~X ETH right now" at the standard tier, 21000 gas), the blob base fee, and upstream_syncing flagging a lagging node. Call this first when unsure which chain you are on, or when the question is what gas costs now. upstream reports what the configured RPC endpoint can do, probed once and cached: trace (debug_traceTransaction — decides how transaction failure analysis works) and batch_cap (JSON-RPC batch limit); null means the probe could not tell. There is deliberately no archive field: assume historical state IS available and simply make the read you want. If the node cannot serve that block the read fails with HISTORICAL_STATE_UNAVAILABLE, naming the block and what to change — a real answer about the request you actually made. Do not plan around a history limit before you have hit one. Wraps eth_chainId, eth_getBlockByNumber, eth_feeHistory, eth_blobBaseFee, and eth_syncing. All fees are decimal strings in wei plus a gwei or ether convenience form; base-fee-derived fields are null on pre-EIP-1559 chains. An optional historical block returns that block\'s base fee with the current-only fields null (announced in note).',
  input,
  output,
  idempotent: false,
  handler: chainStatusHandler,
})
