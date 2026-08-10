import { decodeAbiParameters, getAddress, toEventSelector, toFunctionSelector } from 'viem'
import type { LogEntry } from './types'

/** Bundled ABI knowledge is a deliberate minimum: no fetching, no inference. */

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')
const APPROVAL_TOPIC = toEventSelector('Approval(address,address,uint256)')
const APPROVAL_FOR_ALL_TOPIC = toEventSelector('ApprovalForAll(address,address,bool)')

const KNOWN_METHODS: ReadonlyMap<string, string> = new Map(
  (
    [
      'transfer(address,uint256)',
      'transferFrom(address,address,uint256)',
      'approve(address,uint256)',
      'safeTransferFrom(address,address,uint256)',
      'safeTransferFrom(address,address,uint256,bytes)',
      'setApprovalForAll(address,bool)',
      'mint(address,uint256)',
      'burn(uint256)',
      'deposit()',
      'withdraw(uint256)',
    ] as const
  ).map((sig) => [toFunctionSelector(sig), sig.slice(0, sig.indexOf('('))]),
)

export interface DecodedMethod {
  selector: string
  /** null when the selector is outside the bundled set — undecoded, not an error */
  name: string | null
}

/** Method of a transaction from its calldata; null for plain value transfers (empty input). */
export const decodeMethod = (input: `0x${string}`): DecodedMethod | null => {
  if (input === '0x' || input.length < 10) return null
  const selector = input.slice(0, 10).toLowerCase()
  return { selector, name: KNOWN_METHODS.get(selector) ?? null }
}

export interface DecodedTokenEvent {
  standard: 'erc20' | 'erc721'
  event: 'transfer' | 'approval' | 'approval_for_all'
  token: string
  from: string
  to: string
  amount_raw: string | null
  token_id: string | null
  approved: boolean | null
  log_index: number
}

const topicAddress = (topic: `0x${string}`): string => getAddress(`0x${topic.slice(26)}`)

const dataWord = (data: `0x${string}`): bigint | null =>
  /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null

/**
 * Decode ONE log as an ERC-20/721 Transfer or Approval event; null = outside
 * the bundled set (undecoded, not an error). ERC-20 and ERC-721 share event
 * signatures; they are told apart by indexing: ERC-20 carries the amount in
 * data (3 topics), ERC-721 indexes the token id (4 topics).
 */
export const decodeTokenEvent = (log: LogEntry): DecodedTokenEvent | null => {
  const [topic0, a, b, c] = log.topics
  if (topic0 === TRANSFER_TOPIC && a && b) {
    if (c === undefined) {
      const amount = dataWord(log.data)
      if (amount === null) return null
      return {
        standard: 'erc20',
        event: 'transfer',
        token: log.address,
        from: topicAddress(a),
        to: topicAddress(b),
        amount_raw: amount.toString(),
        token_id: null,
        approved: null,
        log_index: log.logIndex,
      }
    }
    return {
      standard: 'erc721',
      event: 'transfer',
      token: log.address,
      from: topicAddress(a),
      to: topicAddress(b),
      amount_raw: null,
      token_id: BigInt(c).toString(),
      approved: null,
      log_index: log.logIndex,
    }
  }
  if (topic0 === APPROVAL_TOPIC && a && b) {
    if (c === undefined) {
      const amount = dataWord(log.data)
      if (amount === null) return null
      return {
        standard: 'erc20',
        event: 'approval',
        token: log.address,
        from: topicAddress(a),
        to: topicAddress(b),
        amount_raw: amount.toString(),
        token_id: null,
        approved: null,
        log_index: log.logIndex,
      }
    }
    return {
      standard: 'erc721',
      event: 'approval',
      token: log.address,
      from: topicAddress(a),
      to: topicAddress(b),
      amount_raw: null,
      token_id: BigInt(c).toString(),
      approved: null,
      log_index: log.logIndex,
    }
  }
  if (topic0 === APPROVAL_FOR_ALL_TOPIC && a && b) {
    const flag = dataWord(log.data)
    if (flag === null) return null
    return {
      standard: 'erc721',
      event: 'approval_for_all',
      token: log.address,
      from: topicAddress(a),
      to: topicAddress(b),
      amount_raw: null,
      token_id: null,
      approved: flag !== 0n,
      log_index: log.logIndex,
    }
  }
  return null
}

/** Decode a batch of logs, silently skipping everything outside the bundled set. */
export const decodeTokenEvents = (logs: readonly LogEntry[]): DecodedTokenEvent[] =>
  logs.map(decodeTokenEvent).filter((e): e is DecodedTokenEvent => e !== null)

/** Event-signature topics exported for filter building (get_events presets). */
export const EVENT_TOPICS = {
  transfer: TRANSFER_TOPIC,
  approval: APPROVAL_TOPIC,
  approvalForAll: APPROVAL_FOR_ALL_TOPIC,
} as const

/** 32-byte topic encoding of an address (left-padded). */
export const addressTopic = (address: string): `0x${string}` =>
  `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

// ---------- revert-data decoding (failure analysis) ----------

const ERROR_STRING_SELECTOR = '0x08c379a0' // Error(string)
const PANIC_SELECTOR = '0x4e487b71' // Panic(uint256)

const PANIC_CODES: ReadonlyMap<bigint, string> = new Map<bigint, string>([
  [0x00n, 'generic compiler panic'],
  [0x01n, 'assert(false)'],
  [0x11n, 'arithmetic overflow or underflow'],
  [0x12n, 'division or modulo by zero'],
  [0x21n, 'invalid enum conversion'],
  [0x22n, 'corrupted storage byte array'],
  [0x31n, 'pop() on an empty array'],
  [0x32n, 'array index out of bounds'],
  [0x41n, 'memory allocation overflow'],
  [0x51n, 'call to an uninitialized internal function'],
])

/**
 * Turn raw revert return data into a human-readable reason.
 * Standard Error(string) and Panic(uint256) are decoded fully; custom errors
 * are reported as selector + data — naming them needs the contract ABI, which
 * is deliberately outside this public tier.
 */
export interface RevertWord {
  hex: `0x${string}`
  /** the same word read as a uint256 — the common case for amounts and ids */
  uint256: string
  /**
   * Set only when the word is almost certainly an address: correctly padded AND
   * large enough that no realistic amount or id could collide (a real address
   * has a nonzero leading byte; the largest token supplies are ~1e27, far below
   * this bound). Left null when the bytes are ambiguous rather than guessed at.
   */
  address: string | null
}

/** Naming a custom error needs its ABI; reading its arguments does not. */
export const splitRevertWords = (data: `0x${string}`): RevertWord[] | null => {
  if (data.length <= 10) return null
  const body = data.slice(10)
  if (body.length === 0 || body.length % 64 !== 0) return null
  const words: RevertWord[] = []
  for (let i = 0; i < body.length; i += 64) {
    const hex = `0x${body.slice(i, i + 64)}` as const
    const value = BigInt(hex)
    const ADDRESS_FLOOR = 2n ** 152n
    const isAddress = /^0x0{24}[0-9a-fA-F]{40}$/.test(hex) && value >= ADDRESS_FLOOR
    words.push({
      hex,
      uint256: value.toString(),
      address: isAddress ? getAddress(`0x${hex.slice(26)}`) : null,
    })
  }
  return words
}

export const describeRevertData = (data: `0x${string}`): string => {
  if (data === '0x') {
    return 'reverted with no revert data (a bare require/revert without a message, an invalid opcode, or out-of-gas inside an inner call)'
  }
  const selector = data.slice(0, 10).toLowerCase()
  const rest: `0x${string}` = `0x${data.slice(10)}`
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const [message] = decodeAbiParameters([{ type: 'string' }], rest)
      return `reverted with reason: "${message}"`
    } catch {
      return `reverted with a malformed Error(string) payload (data: ${data})`
    }
  }
  if (selector === PANIC_SELECTOR) {
    try {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], rest)
      const meaning = PANIC_CODES.get(code) ?? 'unknown panic code'
      return `reverted with Panic(0x${code.toString(16)}): ${meaning}`
    } catch {
      return `reverted with a malformed Panic(uint256) payload (data: ${data})`
    }
  }
  return `reverted with custom error ${selector} (data: ${data}) — naming custom errors requires the contract ABI, which this server does not fetch`
}
