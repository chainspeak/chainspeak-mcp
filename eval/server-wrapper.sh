#!/usr/bin/env bash
# Launches the chainspeak MCP server (stdio) for evaluation runs.
# stdout = MCP protocol; stderr (pino logs) is redirected to $EVAL_SERVER_LOG
# so the harness can extract per-tool call counts and durations per task.
set -euo pipefail
cd "$(dirname "$0")/.."
export ETH_RPC_URL="${ETH_RPC_URL:-https://eth.drpc.org}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
if [ -n "${EVAL_SERVER_LOG:-}" ]; then
  exec npx tsx src/adapters/stdio.ts 2>>"$EVAL_SERVER_LOG"
else
  exec npx tsx src/adapters/stdio.ts
fi
