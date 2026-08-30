# Cutover runbook — try.chainspeak.dev

Moves the production Worker behind **https://try.chainspeak.dev** from the old
video-01 code to the current code in this repo (`chainspeak-mcp@0.1.0`).

Run everything from this repo, on branch **`cutover-video-02`**.

> The landing worker (`chainspeak-landing`, repo `landing-snippet`) owns the
> exact-root HTML route for `chainspeak.dev` / `try.chainspeak.dev` and forwards
> MCP traffic through a **service binding to a script named `chainspeak-mcp`**.
> This cutover does **not** touch the landing worker at all — no route changes,
> no redeploy there. That is exactly why `wrangler.jsonc` must keep
> `"name": "chainspeak-mcp"`: deploying under any other name creates a *second*,
> unreferenced Worker and leaves the live domain on the old code.

---

## ⛔ BLOCKER — fix this before deploying

Found during the local smoke test on 2026-08-30 (`wrangler dev --local`,
this exact config). **Do not deploy until this is fixed** — the current
`main` code hangs on Cloudflare in the normal client flow.

**Symptom.** In a fresh isolate:

- if the *first* request is a `tools/call`, it works (≈0.9–2.7 s, correct block);
- if the first request is anything else (`initialize`, which is what every MCP
  client sends first), then **every subsequent `tools/call` in that isolate
  never responds**. The SSE stream opens with `200 OK` and stays silent
  forever — no error, no log line, no timeout. Reproduced with a 20 s, a 60 s
  and a 90 s client timeout; a captured worker span shows `outcome=ok,
  duration_ms=180249`.

In production that means: an MCP client connects, initializes, and every tool
call afterwards hangs until the isolate is recycled. `/healthz` and
`tools/list` keep working, so a shallow check looks green.

**Root cause.** `src/adapters/worker.ts`:

```ts
void verifyChains(deps.registry).mapErr((e) => deps.log.error({ hint: e.hint }, e.message))
```

`build(env)` runs inside the *first* request, and this fire-and-forget call
starts RPC fetches that are never awaited and never attached to
`ctx.waitUntil` — the worker's `fetch(req, env)` does not even take `ctx`.
When that first response completes, workerd tears the request's I/O context
down and those in-flight fetches can never settle. The viem client is cached
in the module-scope `cached` closure and its http transport runs with
`batch: { batchSize: 3 }`, so the unsettled batch/promise stays in the client's
cache and every later call awaits a promise that can never resolve.

**Verified fix.** Deleting that one line makes the flow work: `initialize`
then `tools/call` returned a live block in 0.87 s in the same isolate. Options,
in order of preference:

1. Drop `verifyChains` from the worker adapter (it is log-only there anyway;
   the stdio/http adapters keep it), or
2. keep it but give it a real context: change the handler to
   `fetch(req, env, ctx)` and `ctx.waitUntil(verifyChains(...))` — this still
   races a second request arriving while the verify is in flight, so (1) is safer, or
3. run the check lazily inside the request that needs it.

After fixing, re-run the local smoke test in step 4 order (initialize →
tools/list → tools/call) against `wrangler dev` before deploying.

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

Confirm which Worker scripts actually exist in the account and when they last
shipped:

```bash
npx wrangler deployments list --name chainspeak-mcp
npx wrangler deployments list --name basic-mcp-rpc-example
```

> Not verified by the agent that prepared this branch: `npx wrangler whoami`
> reported *not authenticated*, so no Cloudflare API call was made. This is the
> first thing you check after logging in.

Expected: **`chainspeak-mcp` exists** (this is the script the landing worker's
service binding points at, and the one serving try.chainspeak.dev today; its
last deployment should be the old video-01 code).

- If `chainspeak-mcp` errors with "script not found" and `basic-mcp-rpc-example`
  is the one that exists → **stop**. The live script is named differently than
  assumed; re-check the landing worker's service binding (`wrangler.jsonc` in
  `landing-snippet`) and set `name` in this repo to whatever that binding
  targets before deploying.

Optional extra confirmation of the binding target:

```bash
grep -n "service" ../landing-snippet/wrangler.jsonc
```

## 3. Dry run, then deploy

> Only after the BLOCKER above is fixed and the local smoke test passes.
> Dry run on this config already builds clean: **Total Upload 1451.97 KiB /
> gzip 286.89 KiB**, six env vars bound, `nodejs_compat` on.

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
npx wrangler deployments list --name chainspeak-mcp   # find the previous version id
npx wrangler rollback --name chainspeak-mcp           # interactive: pick previous
# or, non-interactive, straight to a known-good version:
npx wrangler rollback <VERSION_ID> --name chainspeak-mcp --message "revert video-02 cutover"
```

Rollback is instant and does not touch the landing worker. Re-run the step 4a/4b
checks afterwards to confirm the old behaviour is back.

## 6. After a green cutover

```bash
git checkout main
git merge cutover-video-02
```

(No push happens as part of this runbook; push when you're ready.)
