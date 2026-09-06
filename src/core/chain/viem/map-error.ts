import {
  BaseError,
  ContractFunctionExecutionError,
  HttpRequestError,
  LimitExceededRpcError,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  RpcError,
  RpcRequestError,
  TimeoutError,
} from 'viem'
import {
  type ChainError,
  contractCallFailed,
  historicalStateUnavailable,
  internal,
  unsupported,
  upstreamPolicy,
  upstreamTransient,
} from '../errors'

/**
 * Transient failures were ALREADY retried by the transport before reaching here.
 * The hard-won rule (eval finding #4): a deterministic rejection such as a batch
 * cap must NEVER be labelled retryable — doing so cost an agent 8 retries and 103
 * wasted seconds. The converse is just as bad: telling a caller not to retry a
 * timeout that succeeds on retry.
 */
const TRANSIENT_TEXT =
  /timeout|timed out|rate.?limit|too many|throttl|overloaded|capacity|temporar|try again|\bretry\b|busy|upstream error|no healthy|bad gateway/i

/** Checked BEFORE the transient rules: "too many results" is not "too many requests". */
const TOO_LARGE_TEXT =
  /(response|body|payload|result)[^.]{0,24}(too large|size limit|exceeded)|too many (results|logs|matches|records)|query returned more than|result set too large/i

/**
 * A capability the plan does not include — tracing, archive, an entire method.
 * No amount of waiting adds it, so this really is UPSTREAM_POLICY: change the
 * request or change the endpoint.
 */
const PLAN_GATED_TEXT =
  /not (available|included|supported|enabled)[^.]{0,30}\b(plan|tier|subscription)\b|requires? (a |an )?(paid|higher|pro|premium|upgraded)\s*(plan|tier|subscription)|\b(plan|tier|subscription)\b[^.]{0,30}does not (include|support)/i

/**
 * A spent budget that refills — usage allowance, credits, a daily cap.
 *
 * This used to live in the same regex as the plan gate above, under the rule "a
 * free-tier TIMEOUT is transient; a free-tier QUOTA is not". Field-disproved on
 * 2026-09-06: arbitrum.drpc.org refused with "You've reached the usage limit for
 * your current plan … please upgrade", and the identical call succeeded minutes
 * later. The allowance is a bucket, and buckets refill.
 *
 * The old rule was still protecting something real — retrying instantly, in a
 * spiral, cannot help. That is why this maps to UPSTREAM_TRANSIENT *with*
 * `retry_after_ms`: the agent waits rather than spins, and both conclusions hold.
 *
 * Note what is deliberately NOT here: "upgrade". Billing wording says nothing
 * about determinism. It appeared verbatim in both a refilling usage limit and a
 * plain "Request timeout on the free plan, please upgrade to paid plan" — and
 * while it sat in this pattern it made that literal timeout non-retryable.
 */
const USAGE_LIMIT_TEXT =
  /usage limit|\bquota\b|\bcredits?\b|exceeded your|daily limit|monthly limit|out of (units|credits|requests)/i

/** How long to wait on a refilling allowance when the provider suggests nothing. */
const USAGE_LIMIT_BACKOFF_MS = 60_000

/** Only a genuine plan gate may veto a transient reading — never billing wording. */
const looksTransient = (text: string): boolean =>
  TRANSIENT_TEXT.test(text) && !PLAN_GATED_TEXT.test(text)

/**
 * Every scrap of text an error carries, for CLASSIFICATION ONLY. viem's raw
 * `message` embeds the request URL, which carries the provider API key, so this
 * string must never reach the caller — emit providerMessageOf/shortMessageOf.
 */
const allTextOf = (e: unknown): string => {
  const parts: string[] = []
  let cur: unknown = e
  for (let depth = 0; depth < 6 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof BaseError)
      parts.push(cur.shortMessage, cur.details ?? '', cur.metaMessages?.join(' ') ?? '')
    if (cur instanceof Error) parts.push(cur.message)
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(' ')
}

export function mapViemError(e: unknown): ChainError {
  const timeout = findError(e, TimeoutError)
  if (timeout) {
    return upstreamTransient(
      shortMessageOf(timeout, 'the RPC request timed out'),
      'the RPC endpoint did not answer in time despite retries; if this persists, configure a faster ETH_RPC_URL',
    )
  }

  // Checked BEFORE any branch that can label something deterministic. A provider
  // reporting a timeout or overload is describing a passing condition, whatever
  // error class or JSON-RPC code it chose to carry it in — and telling the caller
  // "retrying will fail again" about a call that succeeds on retry is the worst
  // thing this mapper can do (field-verified: identical call, seconds later, ok).
  const text = allTextOf(e)
  if (TOO_LARGE_TEXT.test(text)) {
    const carrier = findError(e, BaseError)
    return upstreamPolicy(
      firstLine(
        carrier === undefined
          ? 'the response was too large for the RPC endpoint to return'
          : providerMessageOf(carrier, 'the response was too large for the RPC endpoint to return'),
      ),
      'the request matched more data than the endpoint will return in one response — narrow it (a smaller block range is usually the fix, and a busy contract can emit thousands of logs per block) and page through; retrying it unchanged will fail again',
    )
  }
  // A spent allowance, checked before the general transient rule so it carries a
  // wait. NOT before the plan gate: a plan that never included the method is a
  // different thing, and falls through to the deterministic branches below
  // (method-not-found stays UNSUPPORTED, which is what the trace fallback reads).
  if (
    USAGE_LIMIT_TEXT.test(text) &&
    !PLAN_GATED_TEXT.test(text) &&
    !TOO_LARGE_TEXT.test(text) &&
    !isArchiveGap(text) &&
    !/revert|execution reverted/i.test(text)
  ) {
    const carrier = findError(e, BaseError)
    const withHeaders = findError(e, HttpRequestError)
    return upstreamTransient(
      firstLine(
        carrier === undefined
          ? "the RPC provider refused the request on its usage allowance, not on the request's contents"
          : providerMessageOf(
              carrier,
              "the RPC provider refused the request on its usage allowance, not on the request's contents",
            ),
      ),
      'the endpoint refused this on a usage allowance that refills, so the identical call works again once it does — wait retry_after_ms rather than retrying immediately. Do NOT rewrite or narrow the request: nothing about its shape caused this. If it keeps happening, the allowance is too small for the work — use a paid or different RPC endpoint.',
      parseRetryAfter(withHeaders?.headers) ?? USAGE_LIMIT_BACKOFF_MS,
    )
  }
  if (looksTransient(text) && !isArchiveGap(text) && !/revert|execution reverted/i.test(text)) {
    const carrier = findError(e, BaseError)
    return upstreamTransient(
      firstLine(
        carrier === undefined
          ? 'the RPC provider could not serve the request in time'
          : providerMessageOf(carrier, 'the RPC provider could not serve the request in time'),
      ),
      'the provider reported a passing condition (a timeout, overload, or busy node) rather than a rejection of the request itself — the identical call may well succeed; retry it, and if it persists use a faster or paid endpoint',
    )
  }

  const http = findError(e, HttpRequestError)
  if (http) {
    if (http.status === 429) {
      const after = parseRetryAfter(http.headers)
      return upstreamTransient(
        shortMessageOf(http, 'rate limited by the RPC provider'),
        'the provider is rate-limiting requests; space out calls or wait before retrying',
        after,
      )
    }
    if (http.status !== undefined && http.status >= 400 && http.status < 500) {
      const text = `${shortMessageOf(http, '')} ${fullTextOf(http)}`
      // 403 and 408 are the shapes a load-balanced provider uses for "this
      // particular upstream would not serve you just now" — a retry can land on
      // a node that does. Only call a 4xx deterministic when it really is.
      const retryable =
        http.status === 408 ||
        (http.status === 403 && !PLAN_GATED_TEXT.test(text)) ||
        looksTransient(text)
      if (retryable) {
        return upstreamTransient(
          shortMessageOf(http, `the RPC provider refused the request (HTTP ${http.status})`),
          `the provider refused this request with HTTP ${http.status}, which it also does when a node is busy or a method is unavailable on the node that answered — retrying can reach a different node; if it persists, the endpoint genuinely does not allow this request`,
        )
      }
      return upstreamPolicy(
        `the RPC provider rejected the request (HTTP ${http.status})`,
        'this rejection is deterministic — retrying the same request will fail again; check the request against the provider limits or its auth requirements',
      )
    }
    return upstreamTransient(
      shortMessageOf(http, 'RPC transport error'),
      'the RPC endpoint is unreachable or failing despite retries; if this persists, check the endpoint or configure a fallback ETH_RPC_URL',
    )
  }

  const limit = findError(e, LimitExceededRpcError)
  if (limit) {
    const text = fullTextOf(limit)
    if (/rate|too many|per second|per minute|quota|slow down/i.test(text)) {
      return upstreamTransient(
        providerMessageOf(limit, 'RPC rate limit exceeded'),
        'the provider is rate-limiting; space out calls or wait before retrying',
      )
    }
    return upstreamPolicy(
      providerMessageOf(limit, 'the RPC provider rejected the request as over a fixed limit'),
      'the provider enforces a hard cap (batch size, block range, or response size) — make the request smaller; retrying it unchanged will fail again',
    )
  }

  const notSupported =
    findError(e, MethodNotFoundRpcError) ?? findError(e, MethodNotSupportedRpcError)
  if (notSupported) {
    return unsupported(
      providerMessageOf(notSupported, 'the RPC endpoint does not support this method'),
      'the configured RPC endpoint does not offer this RPC method — use an endpoint that does',
    )
  }

  const contract = findError(e, ContractFunctionExecutionError)
  if (contract) {
    const inner = findError(e, RpcError) ?? findError(e, RpcRequestError)
    if (inner && isArchiveGap(fullTextOf(inner))) return archiveGap(inner)
    return contractCallFailed(shortMessageOf(contract, 'contract call failed'))
  }

  const rpc = findError(e, RpcError) ?? findError(e, RpcRequestError)
  if (rpc) {
    if (rpc.code === 429) {
      return upstreamTransient(
        providerMessageOf(rpc, 'rate limited by the RPC provider'),
        'the provider is rate-limiting; space out calls or wait before retrying',
      )
    }
    if (isArchiveGap(fullTextOf(rpc))) return archiveGap(rpc)
    if (/revert|execution reverted/i.test(fullTextOf(rpc))) {
      return contractCallFailed(providerMessageOf(rpc, 'contract call reverted'))
    }
    if (looksTransient(fullTextOf(rpc))) {
      return upstreamTransient(
        providerMessageOf(rpc, 'the RPC provider could not serve the request in time'),
        'the provider reported a passing condition (a timeout or overload) rather than a rejection — retrying is worthwhile; if it persists, use a faster or paid endpoint',
      )
    }
    return upstreamPolicy(
      `the RPC provider rejected the request (code ${rpc.code}): ${providerMessageOf(rpc, 'no detail given')}`,
      'this rejection is deterministic — retrying the same request will fail again; adjust the request to what the provider allows, or check the inputs',
    )
  }

  if (e instanceof BaseError) return internal(shortMessageOf(e, 'unknown RPC failure'))
  return internal(e instanceof Error ? e.message : 'unknown error')
}

/** Provider messages are often multi-line with upsell text; keep the first line. */
const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

const isArchiveGap = (text: string): boolean =>
  /missing trie node|state (is )?not available|state.*pruned|pruned.*state|no historical|archive/i.test(
    text,
  )

const archiveGap = (e: BaseError): ChainError =>
  historicalStateUnavailable(
    providerMessageOf(e, 'the RPC endpoint could not serve state at this historical block'),
    'the node does not hold state this far back. Try a block closer to the head first — most failures here are a read a few hundred thousand blocks too deep, not an endpoint with no history at all. If that block is the point of the question, use an archive-capable RPC (e.g. drpc). Some chains cannot serve their earliest blocks from any node: an Arbitrum Nitro archive node has no pre-migration state.',
  )

type Ctor<T> = abstract new (...args: never[]) => T

function findError<T>(e: unknown, ctor: Ctor<T>): T | undefined {
  if (e instanceof ctor) return e
  if (e instanceof BaseError) {
    const found = e.walk((err) => err instanceof ctor)
    return found ? (found as T) : undefined
  }
  return undefined
}

function shortMessageOf(e: BaseError, fallback: string): string {
  return e.shortMessage || fallback
}

/** Provider error text: prefer details (the upstream message) over viem's generic shortMessage. */
function providerMessageOf(e: BaseError, fallback: string): string {
  return e.details || e.shortMessage || fallback
}

/** Combined text used only for classification, never emitted. */
function fullTextOf(e: BaseError): string {
  return `${e.shortMessage} ${e.details ?? ''}`
}

function parseRetryAfter(headers: Headers | undefined): number | null {
  const raw = headers?.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - Date.now())
}
