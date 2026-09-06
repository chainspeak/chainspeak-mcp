# chainspeak-mcp

MCP server that lets LLMs read Ethereum chain data over JSON-RPC. Read-only, no keys, no signing.

Tools — capability clusters, not endpoint wrappers:

- `chainspeak_get_chain_status` — chain id + name, latest block, base fee, gas tiers (slow/standard/fast), "a transfer costs ~X ETH now", blob fee, sync flag, and the measured `upstream` batch cap
- `chainspeak_get_account` — balance, nonce, is_contract, EIP-7702 delegation, verified reverse ENS; takes an address OR an ENS name, resolved at the same block as the read
- `chainspeak_get_token` — ERC-20 metadata + total supply (no holder needed), optional holder balance, historical `block` support
- `chainspeak_get_transaction` — status, value, gas_limit + gas_used (+%), fee paid precomputed, confirmations, decoded method + ERC-20/721 transfers; failed txs get `failure: {reason, method, confidence}` via debug trace or honest eth_call replay; `detail: summary|full|raw`
- `chainspeak_get_block` — header, tx count, gas fullness, base fee; `detail` adds tx hashes or full transactions, paginated with steering truncation messages
- `chainspeak_get_events` — contract event logs by preset (`transfers`/`approvals` for an account or a whole token, `raw` by contract/topics); Transfer/Approval decoded, everything else honestly `decoded: false`; any range width (walked server-side in windows the provider accepts), paginated
- `chainspeak_resolve_name` — ENS both directions (name→address, address→name with forward verification), block-pinned, EIP-55 output

Conventions every tool follows: responses echo `{chain_id, block_number}`; addresses are EIP-55 checksummed; chain quantities are decimal strings with human-readable twins; blocks accept decimal, 0x-hex, or tags; errors are `{category, retryable, message, hint}` where the hint says what to change — deterministic provider rejections are never labeled retryable.

> **RPC note:** historical-state queries need an archive-capable endpoint — the publicnode
> default is NOT archive; https://eth.drpc.org (free) is. drpc's free tier caps JSON-RPC
> batches at 3, which the server respects automatically.
>
> The server does **not** probe for archive or trace support, and `upstream` has no
> `archive` or `trace` field. Both existed and both lied — each asked a capability question
> up front and read whatever error came back as the answer. On a free-tier quota message
> the archive probe failed closed (`archive: false` from an endpoint whose historical reads
> worked) and the trace probe failed open (claiming `debug_traceTransaction` support that
> was never demonstrated) — and the answers were cached, so they stayed wrong. Just make
> the call: pruned state comes back as `HISTORICAL_STATE_UNAVAILABLE` naming what to change,
> and `get_transaction` falls back to `eth_call` replay with the reason in `failure.note`.

## Requirements

- Node.js >= 20
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env   # set one RPC_URL_<CHAIN> per chain you want
pnpm build
```

## Run over stdio (Claude Desktop, Claude Code, etc.)

Add to your MCP client config, e.g. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chainspeak": {
      "command": "node",
      "args": ["/absolute/path/to/chainspeak-mcp/dist/stdio.mjs"],
      "env": {
        "RPC_URL_ETHEREUM": "https://eth.drpc.org",
        "RPC_URL_BASE": "https://base.drpc.org",
        "RPC_URL_ARBITRUM": "https://arbitrum.drpc.org"
      }
    }
  }
}
```

Add one `RPC_URL_<CHAIN>` per chain. Every tool then takes a `chain` parameter, and
account, transaction and chain-status queries read **all** configured chains by default —
so "what does this address hold?" answers across ethereum, base and arbitrum in one call.
ENS names work on every chain but are always resolved on ethereum, so keep
`RPC_URL_ETHEREUM` set unless you only ever pass 0x addresses.

Or with Claude Code:

```sh
claude mcp add chainspeak \
  -e RPC_URL_ETHEREUM=https://eth.drpc.org \
  -e RPC_URL_BASE=https://base.drpc.org \
  -e RPC_URL_ARBITRUM=https://arbitrum.drpc.org \
  -- node /absolute/path/to/chainspeak-mcp/dist/stdio.mjs
```

## Run over HTTP

```sh
pnpm dev:http
```

Clients connect to `http://localhost:3000/mcp`; `GET /healthz` is a health probe.

Auth is optional: set `MCP_AUTH_TOKEN` (e.g. `openssl rand -hex 24`) and clients must send
`Authorization: Bearer <token>`; leave it unset and the server runs open, logging a warning —
do that only on a private network or behind reverse-proxy auth, since anyone who can reach the
port can spend your RPC quota.

Or with Docker:

```sh
docker compose up --build
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RPC_URL_<CHAIN>` | one of these | — | endpoint for that chain, e.g. `RPC_URL_BASE` |
| `RPC_URL_<CHAIN>_FALLBACK` | no | — | second endpoint for that chain |
| `CHAIN` | no | `ethereum` | chain used when a call names none; must be configured |
| `ETH_RPC_URL` | one of these | — | single-chain shorthand: the endpoint for `CHAIN` |
| `ETH_RPC_URL_FALLBACK` | no | — | second endpoint for failover |
| `ETH_RPC_TIMEOUT_MS` | no | `10000` | per-request timeout |
| `LOG_LEVEL` | no | `info` | pino level, logs go to stderr |
| `MCP_AUTH_TOKEN` | no | — | bearer token, min 16 chars; when set clients must send it, unset runs open |
| `HTTP_PORT` | no | `3000` | HTTP listen port |
| `HTTP_HOST` | no | `0.0.0.0` | HTTP listen host |

Known chains: `ethereum`, `base`, `op-mainnet`, `arbitrum-one`, `polygon`, `bnb-smart-chain`,
`gnosis`, `linea-mainnet`, `sepolia`, `holesky`. Short aliases (`op`, `arbitrum`, `bnb`, `linea`)
and chain ids (`RPC_URL_8453`) also work. The server refuses to start if an endpoint reports a
different chain id than the name it was configured under.

## Development

```sh
pnpm dev     # stdio server from source
pnpm check   # lint + typecheck + dependency rules + tests
```

## License

MIT
