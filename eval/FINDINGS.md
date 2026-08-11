# Tool evaluation findings — baseline (video-01 server)

Run `baseline-01`, 2026-08-08. 8 deterministic tasks, two agents evaluated independently:
**Claude Opus** (headless Claude Code 2.1.224, MCP tools only) and **gpt-5.6-sol** (Codex CLI 0.146.0).
Method adapted from Anthropic's [tool-evaluation cookbook](https://platform.claude.com/cookbook/tool-evaluation-tool-evaluation);
per-tool metrics from the server's own pino logs. Full data: `results/baseline-01/`.

## Headline numbers

| | Claude Opus | gpt-5.6-sol |
|---|---|---|
| Accuracy | **5/8 (62.5%)** | **5/8 (62.5%)** |
| Avg task duration | 50.5s | 32.1s |
| Total tool calls | 21 | 16 |
| Failed tasks | 1, 5, 6 | 1, 5, 6 |

Both models failed the **same three tasks** — the defects are in the tools, not in either model.

## Defects (each → redesign action)

### 1. `eth_resolve_ens` returns lowercase, not EIP-55 — both models failed task 1
Both agents faithfully reported the tool's lowercase address instead of the checksummed form.
Neither "fixed" it from prior knowledge; garbage-cased in, garbage-cased out.
**Action:** return EIP-55 checksummed addresses everywhere.

### 2. `eth_get_transaction` omits `gas_limit` — both models answered NOT_FOUND on task 5
Both agents read the description, correctly concluded the field is unavailable, checked every other
tool for an alternate route, and gave up. Claude's feedback: the summary also drops `nonce`,
`type`, and the EIP-1559 fee caps — "gas limit in particular is a small scalar with none of the
response-size concerns that justify omitting logs and calldata."
**Action:** add `gas_limit` (and consider `nonce`, `tx_type`, fee caps) to the transaction summary.

### 3. No way to read token metadata without inventing a holder — task 6 design gap
`decimals`/`symbol`/`name` are only obtainable as a side effect of a *balance* query, forcing an
arbitrary `holder` for a question that has nothing to do with any holder. Both models called this
out unprompted. **Action:** token metadata must be obtainable directly (a token-info capability, or
the intent-shaped `chainspeak_inspect_asset` from the redesign).

### 4. Error message misdiagnoses a deterministic failure as transient — burned 8 retries
The live failure behind task 6: the RPC provider (drpc free tier) rejects JSON-RPC batches of >3
requests, and `tokenBalance` issues a 4-call batch (balanceOf, decimals, symbol, name — viem
`batch: true`). A **deterministic policy error** was surfaced as *"Temporary network problem …
This is transient — retry the call"*, so Claude retried 8 times across 5 holders and two address
casings (103s wasted) before giving up; Codex likewise 5 times. The agent even proved the
misdiagnosis itself: `eth_resolve_ens` (also `eth_call`-based) worked throughout.
**Action:** (a) propagate the underlying RPC error text/status instead of flattening to "transient";
(b) reserve "retry" advice for failures actually observed to be retryable; (c) make `tokenBalance`
robust to batch-limited providers (sequential fallback, multicall, or cap batch size).

### 5. ENS resolution is not block-pinned — silent correctness hazard (unplanned finding)
Both models flagged it independently on tasks 3/8: "balance of vitalik.eth at block 15000000"
mixes a *latest-state* ENS resolution with a *historical* balance read. If the name had been
re-pointed since that block, the answer would be silently wrong.
**Action:** document loudly, or add a `block` param to resolution; the intent-shaped
`get_account_context` should resolve and read at one consistent block.

### 6. `eth_get_token_balance` has no `block` parameter
Inconsistent with `eth_get_balance`; blocks historical token queries. **Action:** add it.

### 7. Responses are not self-describing
No response echoes the block actually queried or the chain id. A logged result with the default
`block: latest` is unreproducible, and a multi-call aggregation has no proof both reads hit the
same block. **Action:** echo `{block_number, chain_id}` (and resolved inputs) in responses.

### 8. Aggregation falls to the model's mental arithmetic
Task 8 (combined balance of two accounts) required the agent to hand-add 256-bit integers.
Both got it right — Claude cross-checked against the `eth` strings — but it's a correctness risk
no user should depend on. **Action:** the workflow tool should aggregate server-side.

### 9. Papercuts
- `block` accepts decimal strings only; hex (`0xe4e1c0`) — the form users copy from explorers —
  fails schema validation.
- `note: null` dead weight on the success path of `eth_get_transaction`.
- Unicode ENS names fail schema validation instead of getting a domain-level explanation.

## Hypotheses NOT confirmed

- **Name collisions.** Both models judged the `eth_*` names *clear* and noted that MCP client
  namespacing (`mcp__chainspeak__*`) already prevents cross-server collisions. The
  `chainspeak_` prefix rename remains right for branding and for surfaces without client
  namespacing, but "models get confused by generic names" was not observed here — an
  honest demonstration would need a second server with overlapping names connected
  simultaneously (deliberately out of scope for this run).
- **Wrong tool selection.** Zero wrong-tool calls in 16 task runs. The `eth_get_balance` vs
  `eth_get_token_balance` confusion both models called "the pair an agent could confuse" was
  fully prevented by the cross-referencing descriptions.

## What already works (keep in the redesign)

Both models, unprompted, rated the tool descriptions "unusually good" / "among the best I've
seen": wrapped RPC methods named, every return field enumerated, null cases documented as
normal answers ("found: false … is a normal answer, not an error"), and sibling tools
cross-referenced (ENS → balance; native vs ERC-20). Decimal-string numbers (no float loss) and
dual raw/human units were repeatedly praised. These conventions carry over unchanged.

## Open design questions raised by the agents

- Add a raw `eth_call` escape hatch? Both agents wanted one when a narrow tool broke.
  Tension with ChainSpeak's safety-boundary philosophy — decide deliberately, not by default.
- Multichain: every tool is silently mainnet-only; agents repeatedly reached for a `chain` param.
- Block-by-timestamp lookup and a block tool are the most-requested missing reads.

---

# After — tier-1 redesign (batches 1+2)

Run `redesign-02`, 2026-08-09. Same pinned models (Claude Code 2.1.224 / Codex CLI 0.146.0),
same method, all 15 tasks (original 8 + round-two 9–13 + batch-2 14–15). Full data:
`results/redesign-02/`. (An earlier run `redesign-01` was interrupted by a laptop shutdown
after the Claude leg scored 8/8 on the original tasks; its numbers agree with this run.)

## Headline numbers

| | Claude Opus | gpt-5.6-sol |
|---|---|---|
| **Original 8 tasks** | **8/8** (baseline: 5/8) | **8/8** (baseline: 5/8) |
| All 15 tasks | 14/15 (93.3%) | **15/15 (100%)** |
| Avg task duration | 40.7s (baseline 50.5s) | 24.9s (baseline 32.1s) |
| Tool calls, original 8 | 9 (baseline 21) | 9 (baseline 16) |
| Tool calls, all 15 | 38 (18 of them = task 15's honest dead-end investigation) | 17 (1.13/task) |

**Definition of done met: 8/8 on the original tasks for both models.** The single miss
(Claude, task 15) was upstream, not ours — see below.

## Baseline defects → measured outcomes

1. **Lowercase ENS (task 1)** — FIXED. Both models, 1 call, EIP-55 checksummed at the source.
2. **Missing gas_limit (task 5)** — FIXED. The designed trap flip: both models retrieve 163784
   in 1 call where the baseline honestly answered NOT_FOUND.
3. **Holderless token metadata (task 6)** — FIXED. 1 call each, vs the baseline's 11-call flail.
4. **Transient-mislabeled errors / retry spiral** — FIXED twice over. Task 13 (nonexistent
   block): NOT_FOUND in 1 call, ~17–22s, vs the baseline's 8-retry/103s spiral. In task 15,
   `UPSTREAM_POLICY, retryable: false` correctly stopped the agent from retrying at all
   (its words: "the non-retryable flag correctly stopped me from wasting calls").
5. **ENS not block-pinned (tasks 3/8)** — FIXED. `get_account` resolves and reads at one
   pinned block; the 3-call chain is now 1 call.
6. **No token `block` param** — FIXED (and exercised during task 15's investigation).
7. **Responses not self-describing** — FIXED. `{chain_id, block_number}` echo praised:
   "makes results self-describing."
8. **Mental 256-bit arithmetic (task 8)** — REDUCED, not eliminated: 2 `get_account` calls
   + model-side addition (both models correct). A server-side aggregate remains unbuilt
   by choice.
9. **Papercuts** — hex block inputs accepted everywhere; `note: null` dead weight gone;
   descriptions again rated top-tier by both models ("among the best-written tool
   descriptions I've seen"), zero wrong-tool selections in 30 runs.

Batch-2 capabilities measured: failure analysis (task 14: both models extract the traced
revert reason, ≤2 calls) and events (task 15: codex answered the count in 1 call via
`pagination.total`).

## The one miss — and a NEW provider finding

Claude's task 15 failed with `NOT_FOUND` after an exemplary 18-call investigation: during
its window, **drpc refused to route historical `eth_getLogs`** (code 12 "Can't route your
request to suitable provider") for every block older than ~head−10, across bisected ranges,
single blocks, and both presets — while state reads (`get_token` at 19000000) worked fine.
Codex ran the identical query successfully later in the same run, and direct probes before
and after the run return 72 consistently: **drpc's historical-log routing is intermittently
unavailable at minute scale.** The agent refused to fabricate a count from a partial
per-transaction walk and answered honestly — model behavior and error taxonomy both did
their jobs; the upstream did not.

Follow-ups this suggests (unbuilt, candidates for a later batch):
- The probe's `archive` flag conflates archive *state* with archive *logs* — the agent
  proposed `archive_state` vs `archive_logs` (or a probed log-history window). Legitimate:
  the two have different availability on drpc.
- `eth_getBlockReceipts` as a block-level events fallback where getLogs is restricted.
- Consider whether provider text like "revise the provider list" should be rewritten —
  it addresses the server operator, not the calling agent, and misdirected the
  investigation toward input-checking.

## Field validation (Claude Desktop, 2026-08-09)

Two live tx-autopsy sessions against the batch-2 build: `revert_data` with a custom error
selector (`0x7040b58c`, InsufficientValue) let the client decode and fully explain an
exact-output shortfall locally; honest `confidence: "approximate"` labeling made the model
correctly separate calldata-derived facts from state-dependent ones. One defect surfaced
and was fixed the same day: a probed-available trace failing transiently caused a silent
replay fallback — `failure.method_note` now carries the receipt whenever the method used
is weaker than what the probe promised.

## Smaller polish notes from round two

- `token_transfers` reuses `from`/`to` for approval events where owner/spender would read
  better.
- In `get_transaction`, top-level `block_number` (chain head) next to `included_in_block`
  (tx's block) is documented but easy to confuse at a glance.
