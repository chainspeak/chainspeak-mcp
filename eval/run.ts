#!/usr/bin/env tsx
/**
 * Tool-evaluation harness, adapted from the Anthropic cookbook
 * "tool-evaluation" framework (https://platform.claude.com/cookbook/tool-evaluation-tool-evaluation).
 *
 * Differences from the cookbook:
 * - The agent loop is a real MCP client (headless Claude Code, and optionally Codex CLI),
 *   so the tools under test are exactly what real users' clients see.
 * - Per-tool call counts / durations / errors come from the server's own pino logs
 *   (see src/core/mcp/define-tool.ts), captured per task via server-wrapper.sh.
 *
 * Usage:
 *   npx tsx eval/run.ts                        # all tasks, both models
 *   npx tsx eval/run.ts --models claude        # one runner
 *   npx tsx eval/run.ts --tasks 1,7            # subset of tasks
 *   npx tsx eval/run.ts --run-id baseline-01   # named results dir
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const evalDir = dirname(fileURLToPath(import.meta.url))

// ---------- args ----------
const args = process.argv.slice(2)
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const models = opt('models', 'claude,codex').split(',')
const only = opt('tasks', '')
  .split(',')
  .filter(Boolean)
  .map(Number)
const runId = opt('run-id', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const RPC = process.env.ETH_RPC_URL ?? 'https://eth.drpc.org'
const TIMEOUT_MS = 5 * 60 * 1000

// ---------- tasks ----------
interface Task {
  n: number
  prompt: string
  expected: string
}
const xml = readFileSync(join(evalDir, 'tasks.xml'), 'utf8')
const allTasks: Task[] = [
  ...xml.matchAll(
    /<task>[\s\S]*?<prompt>([\s\S]*?)<\/prompt>[\s\S]*?<response>([\s\S]*?)<\/response>[\s\S]*?<\/task>/g,
  ),
].map((m, i) => ({ n: i + 1, prompt: m[1].trim(), expected: m[2].trim() }))
const tasks = allTasks.filter((t) => only.length === 0 || only.includes(t.n))

const contract = readFileSync(join(evalDir, 'output-contract.txt'), 'utf8')
const resultsDir = join(evalDir, 'results', runId)
mkdirSync(resultsDir, { recursive: true })

// ---------- helpers ----------
const extract = (text: string, tag: string): string | null => {
  const m = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
  return m.length ? m[m.length - 1][1].trim() : null
}

interface ToolStats {
  [tool: string]: { count: number; durations: number[]; errors: number }
}
const parseServerLog = (path: string): ToolStats => {
  const stats: ToolStats = {}
  if (!existsSync(path)) return stats
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(line)
      if (j.tool && typeof j.durationMs === 'number') {
        stats[j.tool] ??= { count: 0, durations: [], errors: 0 }
        stats[j.tool].count += 1
        stats[j.tool].durations.push(j.durationMs)
        if (j.msg === 'tool error') stats[j.tool].errors += 1
      }
    } catch {
      /* non-JSON log line */
    }
  }
  return stats
}

// ---------- runners ----------
type Runner = (fullPrompt: string, serverLog: string, tag: string) => Promise<string>

const runClaude: Runner = async (fullPrompt, serverLog, tag) => {
  const cfgPath = join(resultsDir, `mcp-config-${tag}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      mcpServers: {
        chainspeak: {
          command: join(evalDir, 'server-wrapper.sh'),
          args: [],
          env: { EVAL_SERVER_LOG: serverLog, ETH_RPC_URL: RPC },
        },
      },
    }),
  )
  const { stdout } = await exec(
    'claude',
    [
      '-p',
      fullPrompt,
      '--model',
      'opus',
      '--mcp-config',
      cfgPath,
      '--strict-mcp-config',
      '--allowed-tools',
      'mcp__chainspeak__*',
      '--disallowed-tools',
      'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
      '--output-format',
      'json',
    ],
    { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, cwd: resultsDir },
  )
  const parsed = JSON.parse(stdout)
  return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed)
}

const runCodex: Runner = async (fullPrompt, serverLog, tag) => {
  const lastMsg = join(resultsDir, `codex-last-${tag}.txt`)
  const wrapper = join(evalDir, 'server-wrapper.sh')
  const serverToml = `{command = "${wrapper}", args = [], env = {EVAL_SERVER_LOG = "${serverLog}", ETH_RPC_URL = "${RPC}"}}`
  const child = exec(
    'codex',
    [
      'exec',
      '--skip-git-repo-check',
      '-c',
      'mcp_servers.chainspeak.enabled=false',
      '-c',
      'mcp_servers.node_repl.enabled=false',
      '-c',
      `mcp_servers.chainspeak_eval=${serverToml}`,
      '--output-last-message',
      lastMsg,
      fullPrompt,
    ],
    { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, cwd: resultsDir },
  )
  child.child.stdin?.end() // codex exec waits on non-TTY stdin for "additional input"
  await child
  return existsSync(lastMsg) ? readFileSync(lastMsg, 'utf8') : ''
}

const runners: Record<string, Runner> = { claude: runClaude, codex: runCodex }

// ---------- main ----------
interface TaskResult {
  model: string
  task: number
  prompt: string
  expected: string
  actual: string | null
  score: 0 | 1
  durationS: number
  toolStats: ToolStats
  numToolCalls: number
  summary: string | null
  feedback: string | null
  error?: string
}

const versions: Record<string, string> = {}
try {
  versions.claude = (await exec('claude', ['--version'])).stdout.trim()
} catch {}
try {
  versions.codex = (await exec('codex', ['--version'])).stdout.trim()
} catch {}

const results: TaskResult[] = []

for (const model of models) {
  const runner = runners[model]
  if (!runner) {
    console.error(`unknown model runner: ${model}`)
    continue
  }
  for (const task of tasks) {
    const tag = `${model}-task${task.n}`
    const serverLog = join(resultsDir, `${tag}.server.log`)
    const fullPrompt = `${contract}\n\nTASK:\n${task.prompt}`
    console.log(`\n=== ${tag}: ${task.prompt.slice(0, 80)}...`)
    const started = Date.now()
    let raw = ''
    let error: string | undefined
    try {
      raw = await runner(fullPrompt, serverLog, tag)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      console.error(`  runner failed: ${error}`)
    }
    const durationS = (Date.now() - started) / 1000
    writeFileSync(join(resultsDir, `${tag}.output.md`), raw)
    const toolStats = parseServerLog(serverLog)
    const actual = extract(raw, 'response')
    const score: 0 | 1 = actual === task.expected ? 1 : 0
    const numToolCalls = Object.values(toolStats).reduce((a, s) => a + s.count, 0)
    results.push({
      model,
      task: task.n,
      prompt: task.prompt,
      expected: task.expected,
      actual,
      score,
      durationS,
      toolStats,
      numToolCalls,
      summary: extract(raw, 'summary'),
      feedback: extract(raw, 'feedback'),
      error,
    })
    console.log(
      `  ${score ? 'PASS' : 'FAIL'} in ${durationS.toFixed(1)}s — expected "${task.expected}", got "${actual}" (${numToolCalls} tool calls)`,
    )
  }
}

// ---------- report ----------
const fmtStats = (s: ToolStats): string =>
  Object.entries(s)
    .map(
      ([tool, v]) =>
        `${tool}: ${v.count} call(s), avg ${(v.durations.reduce((a, b) => a + b, 0) / v.durations.length).toFixed(0)}ms${v.errors ? `, ${v.errors} error(s)` : ''}`,
    )
    .join('; ') || 'none recorded'

let report = `# Evaluation Report — ${runId}\n\n`
report += `- Date: ${new Date().toISOString()}\n`
report += `- RPC: ${RPC}\n`
for (const [k, v] of Object.entries(versions)) report += `- ${k}: ${v}\n`
report += '\n'

for (const model of models) {
  const rs = results.filter((r) => r.model === model)
  if (rs.length === 0) continue
  const correct = rs.reduce((a, r) => a + r.score, 0)
  const avgDur = rs.reduce((a, r) => a + r.durationS, 0) / rs.length
  const totalCalls = rs.reduce((a, r) => a + r.numToolCalls, 0)
  report += `## ${model}\n\n`
  report += `- **Accuracy: ${correct}/${rs.length} (${((100 * correct) / rs.length).toFixed(1)}%)**\n`
  report += `- Average task duration: ${avgDur.toFixed(1)}s\n`
  report += `- Total tool calls: ${totalCalls} (avg ${(totalCalls / rs.length).toFixed(2)}/task)\n\n`
  for (const r of rs) {
    report += `### Task ${r.task} — ${r.score ? '✅' : '❌'}\n\n`
    report += `**Prompt:** ${r.prompt}\n\n`
    report += `**Expected:** \`${r.expected}\` — **Actual:** \`${r.actual ?? 'N/A'}\`\n\n`
    report += `**Duration:** ${r.durationS.toFixed(1)}s — **Tool calls:** ${fmtStats(r.toolStats)}\n\n`
    if (r.error) report += `**Runner error:** ${r.error}\n\n`
    if (r.summary) report += `**Summary:**\n\n${r.summary}\n\n`
    if (r.feedback) report += `**Feedback:**\n\n${r.feedback}\n\n`
    report += '---\n\n'
  }
}

writeFileSync(join(resultsDir, 'report.md'), report)
writeFileSync(join(resultsDir, 'results.json'), JSON.stringify({ runId, versions, results }, null, 2))
console.log(`\nReport: ${resolve(resultsDir, 'report.md')}`)
