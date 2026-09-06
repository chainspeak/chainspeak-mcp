# Cutover runbook — try.chainspeak.dev

Moves the production Worker behind **https://try.chainspeak.dev** from the old
video-01 code to the current code in this repo (`chainspeak-mcp@0.1.0`).

Run everything from this repo, on branch **`cutover-video-02`**.

> The live worker behind try.chainspeak.dev is named **`basic-mcp-rpc-example`**
> (confirmed in the Cloudflare dashboard: it holds the try.chainspeak.dev route
> plus one other). The *repo* was renamed to chainspeak-mcp; the *worker* was
> not, and there is no worker named `chainspeak-mcp` on the account. That is why
> `wrangler.jsonc` must keep `"name": "basic-mcp-rpc-example"`: deploying under
> any other name creates a *new* worker and strands the domain on the old code.
>
> The landing worker (`chainspeak-landing`, repo `landing-snippet`) owns the
> exact-root HTML route and is **not touched** by this cutover — no route
> changes, no redeploy there.
>
> ⚠️ `landing-snippet/deploy.sh` sets `MCP_WORKER=chainspeak-mcp`. That is wrong
> and must be corrected to `basic-mcp-rpc-example` **before any landing
> redeploy**, or the root-route service binding will point at a worker that does
> not exist.

---

## ✅ Fixed before deploy — workerd hang after `initialize`

Found and fixed on this branch on 2026-08-30 (commit *"fix worker: drop
fire-and-forget verifyChains"*). Recorded here because the failure mode is
invisible to a shallow health check.

**Symptom (before the fix).** In a fresh isolate, if the first request was
anything other than a tool call — i.e. the `initialize` every MCP client sends
— then *every* later `tools/call` in that isolate never responded: the SSE
stream opened with `200 OK` and stayed silent forever (reproduced at 20 s, 60 s
and 90 s client timeouts; one worker span recorded `outcome=ok,
duration_ms=180249`). `/healthz` and `tools/list` kept working the whole time,
so the worker looked green while every real query hung.

**Cause.** `build(env)` runs inside the first request, and
`void verifyChains(deps.registry)` started RPC fetches that were never awaited
and never attached to `ctx.waitUntil`. workerd tears that request's I/O context
down when the response completes, so those fetches could never settle — and the
module-cached viem client (http transport, `batch: { batchSize: 3 }`) kept the
unsettled promise, making every later call await something that can never resolve.

**Fix.** That one line is gone from `src/adapters/worker.ts`; the comment there
explains why it must not come back. The `stdio` and `http` adapters, which have
a process-long context, still verify chain ids at startup.

**Verified after the fix** (`wrangler dev --local`, exact previously-failing
sequence): `/healthz` 200 in 1 ms → `initialize` in 10 ms → `tools/list` with
all seven tools → `chainspeak_get_chain_status` block **25870099** in 1.98 s →
`chainspeak_get_block` in 0.25 s → `chainspeak_get_chain_status` again, all in
the same isolate, three `tool ok` log lines, no hang.

---

## 0. Preconditions

```bash
git checkout cutover-video-02
git status          # clean tree
pnpm install
pnpm check          # lint + typecheck + depcruise + portability + tests
pnpm build
```

`MCP_AUTH_TOKEN` must stay **unset** — `try.chainspeak.dev` is a public endpoint.
Do not run `wrangler secret put` for it.

RPC endpoints ship as plain `vars` in `wrangler.jsonc` (free public
drpc/publicnode URLs, no API keys). Nothing secret is deployed.

## 1. Log in

```bash
npx wrangler whoami
# if it says "You are not authenticated":
npx wrangler login
```

## 2. Verify the script name before deploying

Confirm the script exists and when it last shipped:

```bash
npx wrangler deployments list --name basic-mcp-rpc-example
```

Expected: **`basic-mcp-rpc-example` exists**, with its last deployment being the
old video-01 code. This is the worker holding the try.chainspeak.dev route.

- If it errors with "script not found" → **stop** and re-check the name in the
  Cloudflare dashboard (Workers & Pages → the worker that owns the
  try.chainspeak.dev route) before deploying anything.
- `npx wrangler deployments list --name chainspeak-mcp` should error — no such
  worker exists. If it ever starts existing, someone deployed a stray copy under
  the repo name; delete it rather than pointing the domain at it.

## 3. Dry run, then deploy

> Dry run on this config builds clean: **Total Upload 1451.35 KiB /
> gzip 286.69 KiB**, six env vars bound, `nodejs_compat` on.

```bash
npx wrangler deploy --dry-run --outdir dist-worker   # sanity: bundles clean
npx wrangler deploy
```

Note the **deployment/version ID** wrangler prints — you need it for rollback.

## 4. Post-deploy checks

**a. Health**

```bash
curl -s https://try.chainspeak.dev/healthz    # -> ok
```

**b. MCP tools/list over Streamable HTTP**

```bash
curl -s -X POST https://try.chainspeak.dev/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i | tee /tmp/init.txt | head -20

# grab the session id the server returned, then:
SID=$(grep -i '^mcp-session-id:' /tmp/init.txt | awk '{print $2}' | tr -d '\r')

curl -s -X POST https://try.chainspeak.dev/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST https://try.chainspeak.dev/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Expect all **seven** tools:

```
chainspeak_get_account
chainspeak_get_block
chainspeak_get_chain_status
chainspeak_get_events
chainspeak_get_token
chainspeak_get_transaction
chainspeak_resolve_name
```

**c. One real chain call**

```bash
curl -s -X POST https://try.chainspeak.dev/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chainspeak_get_chain_status","arguments":{"chain":"ethereum"}}}'
```

Expect a current mainnet block number.

**d. Claude Desktop connector (do this once)**

Settings → Connectors → Add custom connector → URL `https://try.chainspeak.dev`
(no auth). Then in a chat: "what's the latest Ethereum block?" — it should call
`chainspeak_get_chain_status` and answer. Re-adding is only needed if the
connector was configured against the old server and misbehaves; otherwise the
existing connector picks up the new tools automatically.

**e. Landing page still fine**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://try.chainspeak.dev/   # served by chainspeak-landing
```

## 5. Rollback

If any check fails, roll back to the previous deployment immediately:

```bash
npx wrangler deployments list --name basic-mcp-rpc-example   # find the previous version id
npx wrangler rollback --name basic-mcp-rpc-example           # interactive: pick previous
# or, non-interactive, straight to a known-good version:
npx wrangler rollback <VERSION_ID> --name basic-mcp-rpc-example --message "revert video-02 cutover"
```

Rollback is instant and does not touch the landing worker. Re-run the step 4a/4b
checks afterwards to confirm the old behaviour is back.

## 6. After a green cutover

```bash
git checkout main
git merge cutover-video-02
```

(No push happens as part of this runbook; push when you're ready.)
