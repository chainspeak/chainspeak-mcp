# basic-mcp-rpc-example

MCP server that lets LLMs read Ethereum chain data over JSON-RPC. Read-only, no keys, no signing.

Tools:

- `eth_get_chain_info` — chain id, latest block, current base fee
- `eth_get_balance` — native ETH balance of an address (wei + ether)
- `eth_get_token_balance` — ERC-20 balance with token metadata

## Requirements

- Node.js >= 20
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env   # set ETH_RPC_URL to your JSON-RPC endpoint
pnpm build
```

## Run over stdio (Claude Desktop, Claude Code, etc.)

Add to your MCP client config, e.g. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eth-rpc": {
      "command": "node",
      "args": ["/absolute/path/to/basic-mcp-rpc-example/dist/stdio.mjs"],
      "env": { "ETH_RPC_URL": "https://ethereum-rpc.publicnode.com" }
    }
  }
}
```

Or with Claude Code:

```sh
claude mcp add eth-rpc -e ETH_RPC_URL=https://ethereum-rpc.publicnode.com \
  -- node /absolute/path/to/basic-mcp-rpc-example/dist/stdio.mjs
```

## Run over HTTP

The HTTP entry requires a bearer token (`openssl rand -hex 24`):

```sh
MCP_AUTH_TOKEN=<token> pnpm dev:http
```

Clients send `Authorization: Bearer <token>` to `http://localhost:3000/mcp`; `GET /healthz` is unauthenticated. Or with Docker:

```sh
docker compose up --build
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ETH_RPC_URL` | yes | — | primary JSON-RPC endpoint |
| `ETH_RPC_URL_FALLBACK` | no | — | second endpoint for failover |
| `ETH_RPC_TIMEOUT_MS` | no | `10000` | per-request timeout |
| `LOG_LEVEL` | no | `info` | pino level, logs go to stderr |
| `MCP_AUTH_TOKEN` | HTTP only | — | bearer token, min 16 chars |
| `HTTP_PORT` | no | `3000` | HTTP listen port |
| `HTTP_HOST` | no | `0.0.0.0` | HTTP listen host |

## Development

```sh
pnpm dev     # stdio server from source
pnpm check   # lint + typecheck + dependency rules + tests
```

## License

MIT
