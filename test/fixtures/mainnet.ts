/**
 * Pinned mainnet facts, verified 2026-08-11. Historical data does not change, so
 * these stay valid — which is what makes them usable by the live conformance
 * layer as well as by hand.
 *
 * Anything MUTABLE (a name whose owner can change a record, a pending
 * transaction) deliberately does not live here: a fixture that a stranger can
 * invalidate produces a suite that fails for reasons unrelated to the code.
 */

export interface Fixture {
  /** what this input exercises that nothing else does */
  covers: string
  value: string
  /** observed when pinned, for the live layer to assert against */
  expect: Record<string, string | null>
}

export const TRANSACTIONS = {
  contractCreation: {
    covers: 'created_contract populated, to === null',
    value: '0x5eb1d5c3a43b8a39bd33c4104ed9cedb903db0aa3c1ef5a9c52e21092d25504a',
    expect: {
      tx_type: 'eip1559',
      to: null,
      created_contract: '0xC9437ADb9D7DF3aCd868fD4698694D065787B39e',
      status: 'success',
    },
  },
  eip2930: {
    covers: 'type-1 access-list transaction',
    value: '0x4f2da921ea3f33197527ef2181f477a057ad7e7520c49527390fd99cfec8354d',
    expect: {
      tx_type: 'eip2930',
      to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      created_contract: null,
      status: 'success',
    },
  },
} satisfies Record<string, Fixture>

export const TOKENS = {
  erc1155: {
    covers: 'an ERC-1155 read as a token: name/symbol answer, supply and decimals do not',
    value: '0x495f947276749Ce646f68AC8c248420045cb7b5e',
    expect: {
      name: 'OpenSea Shared Storefront',
      symbol: 'OPENSTORE',
      decimals: null,
      total_supply_raw: null,
    },
  },
  erc20Bytes32: {
    covers: 'bytes32 name/symbol instead of string (MKR)',
    value: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2',
    expect: { symbol: 'MKR', decimals: '18' },
  },
} satisfies Record<string, Fixture>

export const ENS_FACTS = {
  /** the Universal Resolver deployment height: below it ENS is unreadable */
  universalResolverBlock: 23085558,
  /** resolves only through CCIP-read, so it proves offchain resolution works */
  offchainName: 'jesse.base.eth',
  /** has an ethereum record but none for other chains */
  ethereumOnlyName: 'vitalik.eth',
} as const
