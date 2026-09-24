/**
 * 无头验证脚本 —— 不依赖 Electron，直接跑在 Node 上。
 *   npm run test:core
 *
 * 重点验证四件事：
 *   1. 单行解析在真实数据上不掉字段、在脏数据上不崩
 *   2. 各维度聚合能交叉对上（会话/日/模型/项目 求和 == 全局）
 *   3. traceId 与积分明细的对齐率
 *   4. OpenCode Go 的额度接口：除「真实数据」一段外全部打在本地 mock 服务上
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OpencodeUsage } from '../src/main/opencode-usage'
import type { OpencodeUsageOptions } from '../src/main/opencode-usage'
import { collectSnapshot, localDate, parseUsageLine } from '../src/shared/collector'
import {
  collectKimiSnapshot,
  parseKimiContextLine,
  parseKimiState,
  parseKimiUsageLine,
  parseModelContextSizes
} from '../src/shared/kimi-collector'
import {
  DEFAULT_USAGE_ENDPOINT,
  describeReset,
  parseTime,
  parseUsageResponse,
  quotaLevel,
  quotaSummary,
  quotaWindowLabel,
  quotaWindowShort,
  QUOTA_WINDOW_ORDER,
  recentSamples,
  windowOf
} from '../src/shared/opencode-quota'
import { collectZcodeSnapshot } from '../src/shared/zcode-collector'
import { collectMimoSnapshot } from '../src/shared/mimo-collector'
import { compact, grouped, percent, sourceLabel, SOURCE_ORDER, tokenPerCredit } from '../src/shared/format'
import type { CallRecord, Snapshot, UsageSample } from '../src/shared/types'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}${detail ? `  (${detail})` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

/* ---------------------------------------------------------- 1. 单行解析 */

section('单行解析')

const realLine = JSON.stringify({
  id: 'abc',
  timestamp: 1789368777394,
  type: 'function_call',
  providerData: {
    model: 'deepseek-v4.1-flash',
    traceId: 'e10415d4625d4f0c9b9a7f6931458cf0',
    usage: {
      requests: 1,
      inputTokens: 37668,
      outputTokens: 1560,
      totalTokens: 39228,
      inputTokensDetails: [{ cached_tokens: 8960 }],
      outputTokensDetails: [{ reasoning_tokens: 1520 }]
    }
  }
})

const parsed = parseUsageLine(realLine, 'sid-1', 'proj')
check('解析出记录', parsed !== null)
if (parsed) {
  check('inputTokens', parsed.inputTokens === 37668, String(parsed.inputTokens))
  check('outputTokens', parsed.outputTokens === 1560, String(parsed.outputTokens))
  check('cachedTokens', parsed.cachedTokens === 8960, String(parsed.cachedTokens))
  check('reasoningTokens', parsed.reasoningTokens === 1520, String(parsed.reasoningTokens))
  check('traceId', parsed.traceId === 'e10415d4625d4f0c9b9a7f6931458cf0')
  check('model', parsed.model === 'deepseek-v4.1-flash')
  check('timestamp', parsed.timestamp === 1789368777394)
}

check('无 usage 的行返回 null', parseUsageLine('{"type":"reasoning"}', 's', 'p') === null)
check('坏 JSON 返回 null', parseUsageLine('{"usage":{ broken', 's', 'p') === null)
check(
  '零用量返回 null',
  parseUsageLine(
    JSON.stringify({ providerData: { usage: { inputTokens: 0, outputTokens: 0 }, traceId: 'x' } }),
    's',
    'p'
  ) === null
)

const noTrace = parseUsageLine(
  JSON.stringify({ timestamp: 1, providerData: { model: 'm', usage: { inputTokens: 5, outputTokens: 5 } } }),
  's',
  'p'
)
check('缺 traceId 仍计入 token', noTrace !== null && noTrace.traceId === '', noTrace ? `traceId='${noTrace.traceId}'` : 'null')

const multiDetail = parseUsageLine(
  JSON.stringify({
    providerData: {
      model: 'm',
      traceId: 't',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokensDetails: [{ cached_tokens: 10 }, { cached_tokens: 20 }],
        outputTokensDetails: [{ reasoning_tokens: 5 }, { reasoning_tokens: 7 }]
      }
    }
  }),
  's',
  'p'
)
check('多条 details 求和', multiDetail !== null && multiDetail.cachedTokens === 30 && multiDetail.reasoningTokens === 12)

/* ---------------------------------------------------- 2. 真实数据全量 */

section('真实数据全量扫描')

const workbuddyDir = join(homedir(), '.workbuddy')
const started = Date.now()
const snapshot: Snapshot = collectSnapshot({ workbuddyDir })
const elapsed = Date.now() - started

console.log(`  扫描耗时 ${elapsed} ms（首次，无缓存）`)
console.log(`  会话 ${snapshot.totals.sessions} 个 · 调用 ${grouped(snapshot.totals.calls)} 次`)
console.log(
  `  token 输入 ${compact(snapshot.totals.inputTokens)} · 输出 ${compact(snapshot.totals.outputTokens)}` +
    ` · 缓存 ${compact(snapshot.totals.cachedTokens)} · 思考 ${compact(snapshot.totals.reasoningTokens)}`
)
console.log(
  `  积分 ${snapshot.totals.credits}（权威）· 已归因 ${snapshot.totals.attributedCredits}` +
    ` · 未归因 ${snapshot.totals.unattributedCredits}`
)
console.log(
  `  计费回合 ${snapshot.totals.dbTraces} 条（DB）vs ${snapshot.totals.traces} 个（transcript）` +
    ` · 命中 ${snapshot.totals.matchedTraces}`
)
console.log(`  比价 1 积分 ≈ ${tokenPerCredit(snapshot.totals.inputTokens + snapshot.totals.outputTokens, snapshot.totals.credits)} token`)

// CI 上没有 ~/.workbuddy，真实数据相关的断言必须能整体跳过，否则构建必红
const hasData = snapshot.totals.sessions > 0

if (!hasData) {
  console.log('  skip 未检测到 WorkBuddy 数据 —— 真实数据相关断言全部跳过（CI 环境属正常）')
} else {
  check('扫到会话', snapshot.totals.sessions > 0)
  check('扫到调用', snapshot.totals.calls > 0)
  check('首次扫描在 15 秒内', elapsed < 15_000, `${elapsed} ms`)
  check('有积分数据', snapshot.totals.credits > 0, String(snapshot.totals.credits))
  check('traceId 对齐率 > 50%', snapshot.totals.matchedTraces / Math.max(1, snapshot.totals.traces) > 0.5)

  /* 二次扫描应当能命中文件缓存 */
  const cachedStart = Date.now()
  const cachedSnapshot = collectSnapshot({ workbuddyDir, cache: new Map() })
  const cachedElapsed = Date.now() - cachedStart
  check('冷缓存二次扫描仍可完成', cachedSnapshot.totals.calls === snapshot.totals.calls, `${cachedElapsed} ms`)
}

/* ------------------------------------------------------ 3. 交叉校验 */

section('聚合交叉校验')

const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0)
const near = (a: number, b: number, tolerance = 0.05): boolean => Math.abs(a - b) <= tolerance

check(
  '会话 token 之和 == 全局',
  sum(snapshot.sessions.map((s) => s.inputTokens + s.outputTokens)) ===
    snapshot.totals.inputTokens + snapshot.totals.outputTokens
)
check(
  '模型 token 之和 == 全局',
  sum(snapshot.models.map((m) => m.inputTokens + m.outputTokens)) ===
    snapshot.totals.inputTokens + snapshot.totals.outputTokens
)
check(
  '项目 token 之和 == 全局',
  sum(snapshot.projects.map((p) => p.inputTokens + p.outputTokens)) ===
    snapshot.totals.inputTokens + snapshot.totals.outputTokens
)
check(
  '日 token 之和 == 全局',
  sum(snapshot.days.map((d) => d.inputTokens + d.outputTokens)) ===
    snapshot.totals.inputTokens + snapshot.totals.outputTokens
)

const sessionCreditSum = sum(snapshot.sessions.map((s) => s.credits))
check('会话积分之和 == 已归因积分', near(sessionCreditSum, snapshot.totals.attributedCredits),
  `${sessionCreditSum} vs ${snapshot.totals.attributedCredits}`)
check('日积分之和 == 已归因积分', near(sum(snapshot.days.map((d) => d.credits)), snapshot.totals.attributedCredits),
  `${sum(snapshot.days.map((d) => d.credits))} vs ${snapshot.totals.attributedCredits}`)
check('模型积分之和 == 已归因积分', near(sum(snapshot.models.map((m) => m.credits)), snapshot.totals.attributedCredits),
  `${sum(snapshot.models.map((m) => m.credits))} vs ${snapshot.totals.attributedCredits}`)

/* 权威总额必须等于「已归因 + 未归因」，不能凭空少一截 */
check(
  '权威积分 == 已归因 + 未归因',
  near(snapshot.totals.attributedCredits + snapshot.totals.unattributedCredits, snapshot.totals.credits),
  `${snapshot.totals.attributedCredits} + ${snapshot.totals.unattributedCredits} vs ${snapshot.totals.credits}`
)
check('已归因不超过权威总额', snapshot.totals.attributedCredits <= snapshot.totals.credits + 0.01)

/* 单个 traceId 的积分不能被重复计入 —— 这是最容易写错的地方 */
const modelCreditCeiling = Math.max(...snapshot.models.map((m) => m.credits))
check('模型积分不超过已归因总额（无重复计数）', modelCreditCeiling <= snapshot.totals.attributedCredits + 0.01,
  `max=${modelCreditCeiling} attributed=${snapshot.totals.attributedCredits}`)

/* -------------------------------------------------------- 4. 边界与形态 */

section('边界与形态')

check('日列表非空（有数据时）', !hasData || snapshot.days.length > 0, `${snapshot.days.length} 天`)
check('日列表按时间倒序', snapshot.days.every((d, i) => i === 0 || snapshot.days[i - 1].date >= d.date))
check('会话按活动时间倒序', snapshot.sessions.every((s, i) => i === 0 || snapshot.sessions[i - 1].lastActivity >= s.lastActivity))
check('活跃会话可判定（有数据时）', !hasData || snapshot.active !== null)
check('每个会话都有标题', snapshot.sessions.every((s) => s.title.length > 0))

const todayKey = localDate(Date.now())
const todayDay = snapshot.days.find((d) => d.date === todayKey)
check('今日统计与日列表一致', !todayDay || near(todayDay.inputTokens, snapshot.today.inputTokens, 1),
  todayDay ? `${todayDay.inputTokens} vs ${snapshot.today.inputTokens}` : '今日无数据')

check('空目录不崩', collectSnapshot({ workbuddyDir: join(homedir(), '.workbuddy-nonexistent') }).sessions.length === 0)
check('路径为空不崩', collectSnapshot({ workbuddyDir: '' }).sessions.length === 0)

section('格式化')
check('compact 1.23M', compact(1_234_567) === '1.23M', compact(1_234_567))
check('compact 12.3K', compact(12_345) === '12.3K', compact(12_345))
check('compact 999', compact(999) === '999', compact(999))
check('grouped 千分位', grouped(1_234_567) === '1,234,567', grouped(1_234_567))
check('percent 一位小数', percent(1, 3) === 33.3, String(percent(1, 3)))
check('tokenPerCredit 无积分返回破折号', tokenPerCredit(100, 0) === '—')

/* ---------------------------------------------- 5. Kimi Code 数据源 */

section('Kimi Code 单行解析')

const kimiLine = JSON.stringify({
  type: 'usage.record',
  agentId: 'main',
  model: 'OpenCode Go/deepseek-v4.1-flash',
  usage: { inputOther: 27728, output: 273, inputCacheRead: 1152, inputCacheCreation: 100 },
  usageScope: 'turn',
  time: 1790133260712
})

const kimiCall = parseKimiUsageLine(kimiLine, 'session_x', 'wd_x')
check('解析出记录', kimiCall !== null)
if (kimiCall) {
  check('输入 = other + 缓存读 + 缓存写', kimiCall.inputTokens === 27728 + 1152 + 100, String(kimiCall.inputTokens))
  check('输出', kimiCall.outputTokens === 273, String(kimiCall.outputTokens))
  check('缓存命中 = inputCacheRead', kimiCall.cachedTokens === 1152, String(kimiCall.cachedTokens))
  check('思考 token 恒为 0', kimiCall.reasoningTokens === 0)
  check('模型名', kimiCall.model === 'OpenCode Go/deepseek-v4.1-flash')
  check('时间戳', kimiCall.timestamp === 1790133260712)
  check('没有 traceId（Kimi Code 无这一层）', kimiCall.traceId === '')
}
check('别的类型返回 null', parseKimiUsageLine('{"type":"llm.request","model":"m"}', 's', 'w') === null)
check('坏 JSON 返回 null', parseKimiUsageLine('{"type":"usage.record","usage":{', 's', 'w') === null)
check(
  '零用量返回 null',
  parseKimiUsageLine(
    JSON.stringify({ type: 'usage.record', model: 'm', usage: { inputOther: 0, output: 0 } }),
    's',
    'w'
  ) === null
)

const ctxSample = parseKimiContextLine(
  JSON.stringify({ type: 'token_counting.measured', tokens: 44023, time: 1790126761266 })
)
check('上下文测量解析', ctxSample !== null && ctxSample.tokens === 44023, String(ctxSample?.tokens))
check('上下文测量非本类型返回 null', parseKimiContextLine('{"type":"usage.record"}') === null)

const kimiMeta = parseKimiState(
  JSON.stringify({
    id: 'session_a',
    cwd: 'D:\\proj',
    title: '',
    lastPrompt: '第一行\n第二行',
    updatedAt: 5,
    archived: false
  })
)
check('state.json 缺 title 时回退 lastPrompt 并压成一行', kimiMeta?.title === '第一行 第二行', String(kimiMeta?.title))
check('state.json 取 cwd', kimiMeta?.cwd === 'D:\\proj')
check('state.json 坏 JSON 返回 null', parseKimiState('{ broken') === null)

const sizes = parseModelContextSizes(
  [
    '[thinking]',
    'enabled = true',
    '[models."OpenCode Go/kimi-k3"]',
    'provider = "OpenCode Go"',
    'max_context_size = 1048576',
    '[models.plain]',
    'max_context_size = 128000',
    '[providers."OpenCode Go"]',
    'max_context_size = 999999'
  ].join('\n')
)
check('取到带引号的模型段', sizes.get('OpenCode Go/kimi-k3') === 1048576, String(sizes.get('OpenCode Go/kimi-k3')))
check('取到不带引号的模型段', sizes.get('plain') === 128000, String(sizes.get('plain')))
check('providers 段不参与', !sizes.has('OpenCode Go'), `${sizes.size} 项`)

section('Kimi Code 目录扫描（临时夹具）')

const FIXED_NOW = Date.now()
const fixtureRoot = mkdtempSync(join(tmpdir(), 'wbtm-kimi-'))
const fixtureSession = join(fixtureRoot, 'sessions', 'wd_demo_abc', 'session_demo')
const fixtureMainWire = join(fixtureSession, 'agents', 'main', 'wire.jsonl')
const fixtureSubWire = join(fixtureSession, 'agents', 'agent-0', 'wire.jsonl')
mkdirSync(join(fixtureSession, 'agents', 'main'), { recursive: true })
mkdirSync(join(fixtureSession, 'agents', 'agent-0'), { recursive: true })

const usageLine = (inputOther: number, output: number, cacheRead: number): string =>
  JSON.stringify({
    type: 'usage.record',
    agentId: 'main',
    model: 'demo-model',
    usage: { inputOther, output, inputCacheRead: cacheRead, inputCacheCreation: 0 },
    usageScope: 'turn',
    time: FIXED_NOW
  })

writeFileSync(
  join(fixtureSession, 'state.json'),
  JSON.stringify({ id: 'session_demo', cwd: 'D:\\demo', title: '夹具会话', updatedAt: FIXED_NOW, archived: false })
)
writeFileSync(
  fixtureMainWire,
  [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5' }),
    usageLine(1000, 100, 0),
    usageLine(200, 50, 900),
    JSON.stringify({ type: 'token_counting.measured', tokens: 1150, time: FIXED_NOW })
  ].join('\n') + '\n'
)
writeFileSync(fixtureSubWire, usageLine(300, 30, 0) + '\n')
writeFileSync(join(fixtureRoot, 'config.toml'), '[models."demo-model"]\nmax_context_size = 1000000\n')

const fixture = collectKimiSnapshot({ kimiDir: fixtureRoot, now: FIXED_NOW })
check('kind 标记为 kimi', fixture.kind === 'kimi')
check('扫到 1 个会话', fixture.totals.sessions === 1, String(fixture.totals.sessions))
check('扫到 2 个 wire 文件', fixture.source.files === 2, String(fixture.source.files))
check('子代理调用并入父会话', fixture.totals.calls === 3, String(fixture.totals.calls))
check('输入 token 求和', fixture.totals.inputTokens === 1000 + 1100 + 300, String(fixture.totals.inputTokens))
check('输出 token 求和', fixture.totals.outputTokens === 180, String(fixture.totals.outputTokens))
check('缓存命中求和', fixture.totals.cachedTokens === 900, String(fixture.totals.cachedTokens))
check('没有思考 token', fixture.totals.reasoningTokens === 0)
check(
  '所有粒度的积分都是 0',
  fixture.totals.credits === 0 &&
    fixture.sessions.every((s) => s.credits === 0) &&
    fixture.days.every((d) => d.credits === 0) &&
    fixture.models.every((m) => m.credits === 0) &&
    fixture.today.credits === 0
)
check('计费回合口径留空', fixture.totals.dbTraces === 0 && fixture.totals.traces === 0)
check('上下文水位取主代理最后一次测量', fixture.active?.used === 1150, String(fixture.active?.used))
check('上下文窗口来自 config.toml', fixture.active?.size === 1000000, String(fixture.active?.size))
check('会话标题来自 state.json', fixture.sessions[0]?.title === '夹具会话', fixture.sessions[0]?.title)
check('会话模型取最高频的那个', fixture.sessions[0]?.model === 'demo-model', fixture.sessions[0]?.model)
check('今日统计包含夹具的全部调用', fixture.today.calls === 3, String(fixture.today.calls))

/* 采集器必须只读：夹具文件的 mtime / size 一点都不能变 */
const wireStatBefore = statSync(fixtureMainWire)
collectKimiSnapshot({ kimiDir: fixtureRoot, now: FIXED_NOW })
const wireStatAfter = statSync(fixtureMainWire)
check(
  '采集不修改任何原始文件',
  wireStatBefore.mtimeMs === wireStatAfter.mtimeMs && wireStatBefore.size === wireStatAfter.size
)

rmSync(fixtureRoot, { recursive: true, force: true })

section('Kimi Code 真实数据')

const kimiDir = join(homedir(), '.kimi-code')
const kimiStarted = Date.now()
const kimiReal = collectKimiSnapshot({ kimiDir })
const kimiElapsed = Date.now() - kimiStarted

console.log(`  扫描耗时 ${kimiElapsed} ms（首次，无缓存）`)
console.log(`  会话 ${kimiReal.totals.sessions} 个 · 调用 ${grouped(kimiReal.totals.calls)} 次`)
console.log(
  `  token 输入 ${compact(kimiReal.totals.inputTokens)} · 输出 ${compact(kimiReal.totals.outputTokens)}` +
    ` · 缓存 ${compact(kimiReal.totals.cachedTokens)}`
)
console.log(
  `  当前上下文 ${grouped(kimiReal.active?.used ?? 0)} / ${grouped(kimiReal.active?.size ?? 0)} token`
)

// CI 上没有 ~/.kimi-code，真实数据断言同样要能整体跳过
const hasKimi = kimiReal.totals.calls > 0

if (!hasKimi) {
  console.log('  skip 未检测到 Kimi Code 数据 —— 真实数据相关断言全部跳过（CI 环境属正常）')
} else {
  check('扫到会话', kimiReal.totals.sessions > 0)
  check('扫到调用', kimiReal.totals.calls > 0)
  check('首次扫描在 15 秒内', kimiElapsed < 15_000, `${kimiElapsed} ms`)
  check('积分恒为 0', kimiReal.totals.credits === 0)
  check(
    '会话 token 之和 == 全局',
    sum(kimiReal.sessions.map((s) => s.inputTokens + s.outputTokens)) ===
      kimiReal.totals.inputTokens + kimiReal.totals.outputTokens
  )
  check(
    '模型 token 之和 == 全局',
    sum(kimiReal.models.map((m) => m.inputTokens + m.outputTokens)) ===
      kimiReal.totals.inputTokens + kimiReal.totals.outputTokens
  )
  check(
    '项目 token 之和 == 全局',
    sum(kimiReal.projects.map((p) => p.inputTokens + p.outputTokens)) ===
      kimiReal.totals.inputTokens + kimiReal.totals.outputTokens
  )
  check(
    '日 token 之和 == 全局',
    sum(kimiReal.days.map((d) => d.inputTokens + d.outputTokens)) ===
      kimiReal.totals.inputTokens + kimiReal.totals.outputTokens
  )
  check('缓存命中不超过输入', kimiReal.totals.cachedTokens <= kimiReal.totals.inputTokens)
  check('有活跃会话', kimiReal.active !== null)
  check('每个会话都有标题', kimiReal.sessions.every((s) => s.title.length > 0))
  check(
    '会话按活动时间倒序',
    kimiReal.sessions.every((s, i) => i === 0 || kimiReal.sessions[i - 1].lastActivity >= s.lastActivity)
  )

  /* 二次扫描应当能命中文件缓存 */
  const kimiCachedStart = Date.now()
  const kimiCached = collectKimiSnapshot({ kimiDir, cache: new Map() })
  const kimiCachedElapsed = Date.now() - kimiCachedStart
  check('冷缓存二次扫描仍可完成', kimiCached.totals.calls === kimiReal.totals.calls, `${kimiCachedElapsed} ms`)
}

check('Kimi 目录不存在不崩', collectKimiSnapshot({ kimiDir: join(homedir(), '.kimi-code-nonexistent') }).sessions.length === 0)
check('路径为空不崩', collectKimiSnapshot({ kimiDir: '' }).sessions.length === 0)

/* --------------------------------------------------- 6. ZCode 数据源 */

section('ZCode 目录扫描（临时夹具）')

const zcodeRoot = mkdtempSync(join(tmpdir(), 'wbtm-zcode-'))
mkdirSync(join(zcodeRoot, 'cli', 'db'), { recursive: true })
const fixtureDbPath = join(zcodeRoot, 'cli', 'db', 'db.sqlite')
const fixtureDb = new DatabaseSync(fixtureDbPath)
fixtureDb.exec(`
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_input_tokens INTEGER, status TEXT
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );
`)
const insertUsage = fixtureDb.prepare(
  `INSERT INTO model_usage
     (id, session_id, model_id, started_at, input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
insertUsage.run('u1', 'sess_a', 'demo-model', FIXED_NOW - 3000, 1000, 100, 40, 900, 'completed')
insertUsage.run('u2', 'sess_a', 'demo-model', FIXED_NOW - 1000, 1200, 50, 10, 1100, 'completed')
insertUsage.run('u3', 'sess_b', 'demo-model', FIXED_NOW - 2000, 300, 30, 0, 0, 'completed')
insertUsage.run('u4', 'sess_b', 'demo-model', FIXED_NOW - 1500, 0, 0, 0, 0, 'completed')
const insertSession = fixtureDb.prepare(
  'INSERT INTO session (id, title, directory, project_id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
insertSession.run('sess_a', '夹具会话 A', 'D:\\proj\\a', 'proj_a', FIXED_NOW - 9000, FIXED_NOW - 1000, 0)
insertSession.run('sess_b', '夹具会话 B', 'D:\\proj\\b', 'proj_b', FIXED_NOW - 9000, FIXED_NOW - 2000, FIXED_NOW)
fixtureDb.close()

const zFixture = collectZcodeSnapshot({ zcodeDir: zcodeRoot, now: FIXED_NOW })
check('kind 标记为 zcode', zFixture.kind === 'zcode')
check('扫到 2 个会话', zFixture.totals.sessions === 2, String(zFixture.totals.sessions))
check('零用量的请求被丢掉', zFixture.totals.calls === 3, String(zFixture.totals.calls))
check('输入 token 求和', zFixture.totals.inputTokens === 2500, String(zFixture.totals.inputTokens))
check('输出 token 求和', zFixture.totals.outputTokens === 180, String(zFixture.totals.outputTokens))
check('缓存命中求和', zFixture.totals.cachedTokens === 2000, String(zFixture.totals.cachedTokens))
check('思考 token 单列（不像 Kimi 那样恒为 0）', zFixture.totals.reasoningTokens === 50, String(zFixture.totals.reasoningTokens))
check(
  '所有粒度的积分都是 0',
  zFixture.totals.credits === 0 &&
    zFixture.sessions.every((s) => s.credits === 0) &&
    zFixture.days.every((d) => d.credits === 0) &&
    zFixture.models.every((m) => m.credits === 0) &&
    zFixture.today.credits === 0
)
check('上下文水位取最后一次请求的输入', zFixture.sessions.find((s) => s.sessionId === 'sess_a')?.contextUsed === 1200)
check('模型上限未知时 size 留 0', zFixture.sessions.every((s) => s.contextSize === 0))
check('已归档会话不参与活跃评选', zFixture.active?.sessionId === 'sess_a', String(zFixture.active?.sessionId))
check('会话标题来自 session 表', zFixture.sessions[0]?.title === '夹具会话 A', zFixture.sessions[0]?.title)
check('项目维度用 project_id', zFixture.projects.every((p) => p.projectDir.startsWith('proj_')), zFixture.projects.map((p) => p.projectDir).join('/'))
check('dbRows 记录有效用量行数（零用量的那行不算）', zFixture.source.dbRows === 3, String(zFixture.source.dbRows))

const zcodeStatBefore = statSync(fixtureDbPath)
collectZcodeSnapshot({ zcodeDir: zcodeRoot, now: FIXED_NOW })
const zcodeStatAfter = statSync(fixtureDbPath)
check(
  '采集不修改用量库',
  zcodeStatBefore.mtimeMs === zcodeStatAfter.mtimeMs && zcodeStatBefore.size === zcodeStatAfter.size
)

rmSync(zcodeRoot, { recursive: true, force: true })

section('ZCode 真实数据')

const zcodeDirPath = join(homedir(), '.zcode')
const zcodeStarted = Date.now()
const zcodeReal = collectZcodeSnapshot({ zcodeDir: zcodeDirPath })
const zcodeElapsed = Date.now() - zcodeStarted

console.log(`  读取耗时 ${zcodeElapsed} ms`)
console.log(`  会话 ${zcodeReal.totals.sessions} 个 · 调用 ${grouped(zcodeReal.totals.calls)} 次`)
console.log(
  `  token 输入 ${compact(zcodeReal.totals.inputTokens)} · 输出 ${compact(zcodeReal.totals.outputTokens)}` +
    ` · 缓存 ${compact(zcodeReal.totals.cachedTokens)} · 思考 ${compact(zcodeReal.totals.reasoningTokens)}`
)
console.log(`  当前上下文 ${grouped(zcodeReal.active?.used ?? 0)} token（上限未知）`)

const hasZcode = zcodeReal.totals.calls > 0

if (!hasZcode) {
  console.log('  skip 未检测到 ZCode 数据 —— 真实数据相关断言全部跳过（CI 环境属正常）')
} else {
  check('读到会话', zcodeReal.totals.sessions > 0)
  check('读到调用', zcodeReal.totals.calls > 0)
  check('读取在 15 秒内', zcodeElapsed < 15_000, `${zcodeElapsed} ms`)
  check('积分恒为 0', zcodeReal.totals.credits === 0)
  check(
    '会话 token 之和 == 全局',
    sum(zcodeReal.sessions.map((s) => s.inputTokens + s.outputTokens)) ===
      zcodeReal.totals.inputTokens + zcodeReal.totals.outputTokens
  )
  check(
    '模型 token 之和 == 全局',
    sum(zcodeReal.models.map((m) => m.inputTokens + m.outputTokens)) ===
      zcodeReal.totals.inputTokens + zcodeReal.totals.outputTokens
  )
  check(
    '日 token 之和 == 全局',
    sum(zcodeReal.days.map((d) => d.inputTokens + d.outputTokens)) ===
      zcodeReal.totals.inputTokens + zcodeReal.totals.outputTokens
  )
  check('缓存命中不超过输入', zcodeReal.totals.cachedTokens <= zcodeReal.totals.inputTokens)
  check('有活跃会话', zcodeReal.active !== null)
  check('每个会话都有标题', zcodeReal.sessions.every((s) => s.title.length > 0))
}

check('ZCode 目录不存在不崩', collectZcodeSnapshot({ zcodeDir: join(homedir(), '.zcode-nonexistent') }).sessions.length === 0)
check('路径为空不崩', collectZcodeSnapshot({ zcodeDir: '' }).sessions.length === 0)

/* --------------------------------------------------- 7. MiMo 数据源 */

section('MiMo 目录扫描（临时夹具）')

const mimoRoot = mkdtempSync(join(tmpdir(), 'wbtm-mimo-'))
const mimoCacheRoot = mkdtempSync(join(tmpdir(), 'wbtm-mimo-cache-'))
const mimoDbPath = join(mimoRoot, 'mimocode.db')
const mimoDb = new DatabaseSync(mimoDbPath)
mimoDb.exec(`
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT,
    time_created INTEGER, time_updated INTEGER, data TEXT
  );
  CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, project_id TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );
`)
const insertMimoMessage = mimoDb.prepare(
  'INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
)
const mimoTokens = (
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  modelId = 'demo-model'
): string =>
  JSON.stringify({
    role: 'assistant',
    modelID: modelId,
    providerID: 'demo-provider',
    tokens: {
      total: input + output + reasoning + cacheRead + cacheWrite,
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite }
    },
    cost: 0
  })
insertMimoMessage.run('m1', 'sess_a', 'main', FIXED_NOW - 3000, FIXED_NOW - 3000, mimoTokens(1000, 100, 40, 500, 100))
insertMimoMessage.run('m2', 'sess_a', 'main', FIXED_NOW - 1000, FIXED_NOW - 1000, mimoTokens(200, 50, 10, 1800, 0))
insertMimoMessage.run(
  'm3',
  'sess_b',
  'main',
  FIXED_NOW - 2000,
  FIXED_NOW - 2000,
  mimoTokens(300, 30, 0, 0, 0, 'unknown-model')
)
/* 零用量（引擎会给 <synthetic> 模型写这种）与坏 JSON，都不该被算进去 */
insertMimoMessage.run('m4', 'sess_b', 'main', FIXED_NOW - 1500, FIXED_NOW - 1500, mimoTokens(0, 0, 0, 0, 0))
insertMimoMessage.run('m5', 'sess_a', 'main', FIXED_NOW - 1200, FIXED_NOW - 1200, '{ broken json')
const insertMimoSession = mimoDb.prepare(
  'INSERT INTO session (id, title, directory, project_id, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
insertMimoSession.run('sess_a', '夹具会话 A', 'D:\\proj\\a', 'global', FIXED_NOW - 9000, FIXED_NOW - 1000, 0)
insertMimoSession.run('sess_b', '夹具会话 B', 'D:\\proj\\b', 'proj_b', FIXED_NOW - 9000, FIXED_NOW - 2000, FIXED_NOW)
mimoDb.close()
/* 模型目录：demo-provider/demo-model 有窗口，别的模型查不到 */
writeFileSync(
  join(mimoCacheRoot, 'models.json'),
  JSON.stringify({
    'demo-provider': { models: { 'demo-model': { limit: { context: 1048576, output: 131072 } } } },
    'other-provider': { models: { 'other-model': { limit: { context: 200000 } } } }
  })
)

const mimoFixture = collectMimoSnapshot({ mimoDir: mimoRoot, cacheDir: mimoCacheRoot, now: FIXED_NOW })
check('kind 标记为 mimo', mimoFixture.kind === 'mimo')
check('扫到 2 个会话', mimoFixture.totals.sessions === 2, String(mimoFixture.totals.sessions))
check('零用量与坏 JSON 的行被丢掉', mimoFixture.totals.calls === 3, String(mimoFixture.totals.calls))
check(
  '输入 = input + 缓存读 + 缓存写（与其它三个源相反的口径）',
  mimoFixture.totals.inputTokens === 1000 + 500 + 100 + 200 + 1800 + 300,
  String(mimoFixture.totals.inputTokens)
)
check('缓存命中只算 cache.read', mimoFixture.totals.cachedTokens === 2300, String(mimoFixture.totals.cachedTokens))
check('输出求和', mimoFixture.totals.outputTokens === 180, String(mimoFixture.totals.outputTokens))
check('思考 token 单列', mimoFixture.totals.reasoningTokens === 50, String(mimoFixture.totals.reasoningTokens))
check(
  '所有粒度的积分都是 0',
  mimoFixture.totals.credits === 0 &&
    mimoFixture.sessions.every((s) => s.credits === 0) &&
    mimoFixture.days.every((d) => d.credits === 0) &&
    mimoFixture.models.every((m) => m.credits === 0)
)
check(
  '上下文水位取最后一次请求的 prompt',
  mimoFixture.sessions.find((s) => s.sessionId === 'sess_a')?.contextUsed === 2000,
  String(mimoFixture.sessions.find((s) => s.sessionId === 'sess_a')?.contextUsed)
)
check(
  '上下文窗口来自 models.json',
  mimoFixture.sessions.find((s) => s.sessionId === 'sess_a')?.contextSize === 1048576,
  String(mimoFixture.sessions.find((s) => s.sessionId === 'sess_a')?.contextSize)
)
check('模型不在目录里时窗口留 0', mimoFixture.sessions.find((s) => s.sessionId === 'sess_b')?.contextSize === 0)
check('已归档会话不参与活跃评选', mimoFixture.active?.sessionId === 'sess_a', String(mimoFixture.active?.sessionId))
check('会话标题来自 session 表', mimoFixture.sessions[0]?.title === '夹具会话 A', mimoFixture.sessions[0]?.title)
check('按会话所在目录分组', mimoFixture.projects.map((p) => p.projectDir).sort().join('/') === 'D:\\proj\\a/D:\\proj\\b')

const mimoStatBefore = statSync(mimoDbPath)
collectMimoSnapshot({ mimoDir: mimoRoot, cacheDir: mimoCacheRoot, now: FIXED_NOW })
const mimoStatAfter = statSync(mimoDbPath)
check(
  '采集不修改用量库',
  mimoStatBefore.mtimeMs === mimoStatAfter.mtimeMs && mimoStatBefore.size === mimoStatAfter.size
)

rmSync(mimoRoot, { recursive: true, force: true })
rmSync(mimoCacheRoot, { recursive: true, force: true })

section('MiMo 真实数据')

const mimoDataPath = join(homedir(), '.local', 'share', 'mimocode')
const mimoCachePath = join(homedir(), '.cache', 'mimocode')
const mimoStarted = Date.now()
const mimoReal = collectMimoSnapshot({ mimoDir: mimoDataPath, cacheDir: mimoCachePath })
const mimoElapsed = Date.now() - mimoStarted

console.log(`  读取耗时 ${mimoElapsed} ms`)
console.log(`  会话 ${mimoReal.totals.sessions} 个 · 调用 ${grouped(mimoReal.totals.calls)} 次`)
console.log(
  `  token 输入 ${compact(mimoReal.totals.inputTokens)} · 输出 ${compact(mimoReal.totals.outputTokens)}` +
    ` · 缓存 ${compact(mimoReal.totals.cachedTokens)} · 思考 ${compact(mimoReal.totals.reasoningTokens)}`
)
console.log(
  `  当前上下文 ${grouped(mimoReal.active?.used ?? 0)} / ${grouped(mimoReal.active?.size ?? 0)} token`
)

const hasMimo = mimoReal.totals.calls > 0

if (!hasMimo) {
  console.log('  skip 未检测到 MiMo 数据 —— 真实数据相关断言全部跳过（CI 环境属正常）')
} else {
  check('读到会话', mimoReal.totals.sessions > 0)
  check('读到调用', mimoReal.totals.calls > 0)
  check('读取在 15 秒内', mimoElapsed < 15_000, `${mimoElapsed} ms`)
  check('积分恒为 0', mimoReal.totals.credits === 0)
  check(
    '会话 token 之和 == 全局',
    sum(mimoReal.sessions.map((s) => s.inputTokens + s.outputTokens)) ===
      mimoReal.totals.inputTokens + mimoReal.totals.outputTokens
  )
  check(
    '模型 token 之和 == 全局',
    sum(mimoReal.models.map((m) => m.inputTokens + m.outputTokens)) ===
      mimoReal.totals.inputTokens + mimoReal.totals.outputTokens
  )
  check(
    '日 token 之和 == 全局',
    sum(mimoReal.days.map((d) => d.inputTokens + d.outputTokens)) ===
      mimoReal.totals.inputTokens + mimoReal.totals.outputTokens
  )
  check('缓存命中不超过输入', mimoReal.totals.cachedTokens <= mimoReal.totals.inputTokens)
  check('有活跃会话', mimoReal.active !== null)
  check('每个会话都有标题', mimoReal.sessions.every((s) => s.title.length > 0))
  check('至少有一个会话能算出上下文窗口', mimoReal.sessions.some((s) => s.contextSize > 0))
}

check(
  'MiMo 目录不存在不崩',
  collectMimoSnapshot({ mimoDir: join(homedir(), '.mimo-nonexistent'), cacheDir: mimoCachePath }).sessions.length === 0
)
check('路径为空不崩', collectMimoSnapshot({ mimoDir: '', cacheDir: '' }).sessions.length === 0)

/* ---------------------------------------------- 8. OpenCode Go 数据源 */

/** 实测响应（HTTP 200，239 字节）—— 纯解析与 mock 服务共用这份基准 */
const USAGE_BODY = JSON.stringify({
  usage: {
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-24T11:12:55.339Z' },
    weekly: { status: 'ok', percent: 15, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 7, resetsAt: '2026-10-22T04:35:26.000Z' }
  }
})

/** 无 key 时实测的 401 体 */
const AUTH_ERROR_BODY = JSON.stringify({
  type: 'error',
  error: { type: 'AuthError', message: 'Missing API key.' }
})

/** 只用在本地 mock 上的假密钥 */
const MOCK_KEY = 'oc_test_key_not_a_secret'

/** 没人监听的本地端口：制造网络层失败，不碰外网 */
const DEAD_ENDPOINT = 'http://127.0.0.1:1/zen/go/v1/usage'

interface MockReply {
  status?: number
  body?: string
  /** 延迟回包，用来制造「请求在飞」的窗口 */
  delayMs?: number
}

interface MockServer {
  endpoint: string
  /** 收到的请求，按先后顺序 */
  hits: { authorization: string; path: string }[]
  setReply: (next: MockReply) => void
  close: () => Promise<void>
}

/** 本地额度接口：listen(0) 让系统分配随机端口，除「真实数据」一段外测试不碰网络 */
function startMockServer(initial: MockReply): Promise<MockServer> {
  return new Promise((resolve) => {
    let reply = initial
    let timer: ReturnType<typeof setTimeout> | null = null
    const hits: { authorization: string; path: string }[] = []
    const server = createServer((req, res) => {
      hits.push({ authorization: req.headers.authorization ?? '', path: req.url ?? '' })
      res.on('error', () => {
        // 客户端超时提前断开时，别让 error 事件掀翻进程
      })
      const send = (): void => {
        try {
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
          res.end(reply.body ?? '')
        } catch {
          // 同上：连接已经没了，写不进去就算了
        }
      }
      if (reply.delayMs) {
        timer = setTimeout(send, reply.delayMs)
        timer.unref()
      } else {
        send()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        endpoint: `http://127.0.0.1:${port}/zen/go/v1/usage`,
        hits,
        setReply: (next) => {
          reply = next
        },
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearTimeout(timer)
            // keep-alive 连接会把 close 卡住，先全断掉
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

/** 每个用例自带 server 开关，用完一定关掉，别让 Node 进程挂住 */
async function withMockServer(reply: MockReply, run: (server: MockServer) => Promise<void>): Promise<void> {
  const server = await startMockServer(reply)
  try {
    await run(server)
  } finally {
    await server.close()
  }
}

/** 读 jsonl 采样文件；不存在当空文件 */
function jsonlLines(path: string): UsageSample[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as UsageSample)
}

/**
 * OpenCode Go 的用例整段收在 main 里：它是唯一会发请求的源，必须 await，
 * 汇总也只能等它跑完 —— 所以整段进 async 函数，汇总挂在 main() 的 finally 上。
 */
async function main(): Promise<void> {
  /* 临时目录：mock 夹具与真实数据那次的采样文件都放这儿，结束时统一删 */
  const opencodeRoot = mkdtempSync(join(tmpdir(), 'wbtm-opencode-'))
  const realHistoryRoot = mkdtempSync(join(tmpdir(), 'wbtm-opencode-real-'))
  const historyPath = (name: string): string => join(opencodeRoot, name)
  /* 注入时钟：节流 60 秒、退避 60→300 秒、心跳 30 分钟都靠它推进，测试里不真等 */
  let clock = Date.parse('2026-09-24T12:00:00.000Z')
  const tick = (ms: number): void => {
    clock += ms
  }
  const makeUsage = (
    endpoint: string,
    historyName: string,
    extra: Partial<OpencodeUsageOptions> = {}
  ): OpencodeUsage =>
    new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: historyPath(historyName),
      endpoint,
      keyOverride: MOCK_KEY,
      now: () => clock,
      ...extra
    })

  try {
    /* ------------------------------------------------- 纯解析 */

    section('OpenCode Go 解析（纯函数）')

    const parsedUsage = parseUsageResponse(JSON.parse(USAGE_BODY))
    check(
      '三个窗口按固定顺序解析',
      parsedUsage.map((w) => w.key).join('/') === QUOTA_WINDOW_ORDER.join('/'),
      parsedUsage.map((w) => w.key).join('/')
    )
    check(
      'rolling 百分比',
      windowOf(parsedUsage, 'rolling')?.percent === 5,
      String(windowOf(parsedUsage, 'rolling')?.percent)
    )
    check(
      'weekly 百分比',
      windowOf(parsedUsage, 'weekly')?.percent === 15,
      String(windowOf(parsedUsage, 'weekly')?.percent)
    )
    check(
      'monthly 百分比',
      windowOf(parsedUsage, 'monthly')?.percent === 7,
      String(windowOf(parsedUsage, 'monthly')?.percent)
    )
    check('百分比是数字不是字符串', parsedUsage.every((w) => typeof w.percent === 'number'))
    check('status 原样带出', parsedUsage.every((w) => w.status === 'ok'))
    check(
      'resetsAt 解析成毫秒时间戳',
      windowOf(parsedUsage, 'rolling')?.resetsAt === Date.parse('2026-09-24T11:12:55.339Z'),
      String(windowOf(parsedUsage, 'rolling')?.resetsAt)
    )

    const missingWeekly = parseUsageResponse({
      usage: {
        rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-24T11:12:55.339Z' },
        monthly: { status: 'ok', percent: 7, resetsAt: '2026-10-22T04:35:26.000Z' }
      }
    })
    check(
      '缺 weekly 只回两个窗口',
      missingWeekly.length === 2 && missingWeekly.map((w) => w.key).join('/') === 'rolling/monthly',
      missingWeekly.map((w) => w.key).join('/')
    )
    check('缺的窗口查不到', windowOf(missingWeekly, 'weekly') === null)

    const oddPercents = parseUsageResponse({
      usage: {
        rolling: { status: 'ok', percent: '5' },
        weekly: { status: 'ok', percent: -20 },
        monthly: { status: 'ok', percent: 180 }
      }
    })
    check('percent 是字符串的窗口被丢掉', windowOf(oddPercents, 'rolling') === null)
    check(
      'percent 为负收到 0',
      windowOf(oddPercents, 'weekly')?.percent === 0,
      String(windowOf(oddPercents, 'weekly')?.percent)
    )
    check(
      'percent 超过 100 收到 100',
      windowOf(oddPercents, 'monthly')?.percent === 100,
      String(windowOf(oddPercents, 'monthly')?.percent)
    )
    check('percent 是 NaN 的窗口被丢掉', parseUsageResponse({ usage: { rolling: { percent: Number.NaN } } }).length === 0)
    check('percent 小数四舍五入', parseUsageResponse({ usage: { rolling: { percent: 12.6 } } })[0]?.percent === 13)

    const fallbackUsage = parseUsageResponse({ usage: { rolling: { percent: 5 } } })
    check('status 缺失时回退 ok', fallbackUsage[0]?.status === 'ok', String(fallbackUsage[0]?.status))
    check('status 非字符串时回退 ok', parseUsageResponse({ usage: { rolling: { percent: 5, status: 7 } } })[0]?.status === 'ok')
    check('resetsAt 缺失时是 0', fallbackUsage[0]?.resetsAt === 0)

    const badResets = parseUsageResponse({
      usage: {
        rolling: { percent: 5, resetsAt: '不是时间' },
        weekly: { percent: 5, resetsAt: 12345 },
        monthly: { percent: 5, resetsAt: null }
      }
    })
    check('resetsAt 非法时是 0', badResets.length === 3 && badResets.every((w) => w.resetsAt === 0))
    check('parseTime 非字符串给 0', parseTime(12345) === 0 && parseTime(null) === 0 && parseTime('乱码') === 0)
    check('parseTime 认 ISO 串', parseTime('2026-09-24T11:12:55.339Z') === Date.parse('2026-09-24T11:12:55.339Z'))

    check('usage 整个缺失返回空', parseUsageResponse({}).length === 0)
    check('usage 为 null 返回空', parseUsageResponse({ usage: null }).length === 0)
    check('usage 不是对象返回空', parseUsageResponse({ usage: 'x' }).length === 0)
    check('响应本身为 null / undefined 不崩', parseUsageResponse(null).length === 0 && parseUsageResponse(undefined).length === 0)
    check('窗口项不是对象时跳过', parseUsageResponse({ usage: { rolling: 'x', weekly: null, monthly: 5 } }).length === 0)

    check(
      '窗口短名',
      quotaWindowShort('rolling') === '5h' && quotaWindowShort('weekly') === '周' && quotaWindowShort('monthly') === '月'
    )
    check(
      '窗口长名',
      quotaWindowLabel('rolling') === '5 小时' &&
        quotaWindowLabel('weekly') === '本周' &&
        quotaWindowLabel('monthly') === '本月'
    )
    check('摘要（短）', quotaSummary(parsedUsage) === '5h 5% · 周 15% · 月 7%', quotaSummary(parsedUsage))
    check('摘要（长）', quotaSummary(parsedUsage, 'long') === '5 小时 5% · 本周 15% · 本月 7%', quotaSummary(parsedUsage, 'long'))
    check('没有窗口时摘要说额度未知', quotaSummary([]) === '额度未知')
    check(
      '占用等级 70 起 warn、90 起 danger',
      quotaLevel(0) === 'ok' &&
        quotaLevel(69) === 'ok' &&
        quotaLevel(70) === 'warn' &&
        quotaLevel(89) === 'warn' &&
        quotaLevel(90) === 'danger' &&
        quotaLevel(100) === 'danger'
    )
    check('windowOf 找不到给 null', windowOf([], 'rolling') === null)

    section('OpenCode Go 文案与采样（纯函数）')

    /* 用本地时间构造，断言文案就与时区无关 */
    const resetNow = new Date(2026, 8, 24, 12, 0, 0).getTime()
    check('剩余 30 分钟', describeReset(resetNow + 30 * 60_000, resetNow) === '30 分钟后重置', describeReset(resetNow + 30 * 60_000, resetNow))
    check('剩余不足 1 分钟也给 1 分钟', describeReset(resetNow + 20_000, resetNow) === '1 分钟后重置', describeReset(resetNow + 20_000, resetNow))
    check('剩余 3 小时', describeReset(resetNow + 3 * 3_600_000, resetNow) === '3 小时后重置', describeReset(resetNow + 3 * 3_600_000, resetNow))
    check('剩余 90 分钟按小时四舍五入', describeReset(resetNow + 90 * 60_000, resetNow) === '2 小时后重置', describeReset(resetNow + 90 * 60_000, resetNow))
    check(
      '超过 24 小时显示 月-日 时:分',
      describeReset(new Date(2026, 8, 28, 0, 0, 0).getTime(), resetNow) === '9-28 00:00 重置',
      describeReset(new Date(2026, 8, 28, 0, 0, 0).getTime(), resetNow)
    )
    check(
      '时间已过显示即将重置',
      describeReset(resetNow - 1, resetNow) === '即将重置' && describeReset(resetNow, resetNow) === '即将重置'
    )
    check('时间为 0 显示重置时间未知', describeReset(0, resetNow) === '重置时间未知')

    const day = 24 * 60 * 60_000
    const sampleNow = Date.parse('2026-09-24T12:00:00.000Z')
    const sample = (t: number, rolling = 1, weekly = 2, monthly = 3): UsageSample => ({ t, rolling, weekly, monthly })

    const filtered = recentSamples(
      [sample(sampleNow - 8 * day), sample(sampleNow - 2 * day), sample(sampleNow - 60_000)],
      sampleNow,
      7,
      400
    )
    check(
      '按天过滤掉过期点',
      filtered.length === 2 && filtered[0].t === sampleNow - 2 * day,
      `${filtered.length} 个点`
    )
    check('刚好卡在保留期边界上的点留着', recentSamples([sample(sampleNow - 7 * day)], sampleNow, 7, 400).length === 1)

    const many = Array.from({ length: 10 }, (_, index) => sample(sampleNow - (10 - index) * 60_000))
    const thinned = recentSamples(many, sampleNow, 7, 3)
    check('点数超上限时抽稀', thinned.length < many.length, `${thinned.length} / ${many.length}`)
    check(
      '抽稀后末点一定保留',
      thinned[thinned.length - 1].t === many[many.length - 1].t,
      String(thinned[thinned.length - 1].t)
    )
    check('抽稀后首点仍在', thinned[0].t === many[0].t)
    check('抽稀后仍是升序', thinned.every((s, index) => index === 0 || thinned[index - 1].t < s.t))
    check('上限 <= 0 时不抽稀', recentSamples(many, sampleNow, 7, 0).length === many.length)
    check('点数没超上限时原样返回', recentSamples(many, sampleNow, 7, 400).length === many.length)

    /* ------------------------------------------- 本地 mock 服务集成 */

    section('OpenCode Go 本地 mock 服务集成')

    /* 三个凭证目录：无 auth.json / 合法 auth.json / 坏 auth.json */
    const authDir = join(opencodeRoot, 'with-auth')
    const badAuthDir = join(opencodeRoot, 'bad-auth')
    const noKeyFieldDir = join(opencodeRoot, 'no-key-field')
    mkdirSync(authDir, { recursive: true })
    mkdirSync(badAuthDir, { recursive: true })
    mkdirSync(noKeyFieldDir, { recursive: true })
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_from_file' } }))
    writeFileSync(join(badAuthDir, 'auth.json'), '{"opencode-go":{ broken')
    writeFileSync(join(noKeyFieldDir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api' } }))

    /* 正常路径：请求头、状态、采样落盘 */
    await withMockServer({ body: USAGE_BODY }, async (server) => {
      const usage = makeUsage(server.endpoint, 'ok.jsonl')
      const ok = await usage.pull(true)
      const state = usage.current()
      check('pull 返回 true（真发了请求并成功）', ok === true)
      check('解析出三个窗口', state.windows.length === 3, String(state.windows.length))
      check(
        '百分比与响应一致',
        state.windows.map((w) => w.percent).join('/') === '5/15/7',
        state.windows.map((w) => w.percent).join('/')
      )
      check('窗口顺序固定', state.windows.map((w) => w.key).join('/') === 'rolling/weekly/monthly')
      check('resetsAt 也带过来了', windowOf(state.windows, 'weekly')?.resetsAt === Date.parse('2026-09-28T00:00:00.000Z'))
      check('error 为空', state.error === null, String(state.error))
      check('stale 为 false', state.stale === false)
      check('fetchedAt 就是注入的当前时刻', state.fetchedAt === clock, String(state.fetchedAt))
      check('请求头是 Bearer + 密钥', server.hits[0]?.authorization === `Bearer ${MOCK_KEY}`, server.hits[0]?.authorization ?? '(空)')
      check('请求打到 /zen/go/v1/usage', server.hits[0]?.path === '/zen/go/v1/usage', server.hits[0]?.path ?? '(空)')
      check('只发了一次请求', server.hits.length === 1, String(server.hits.length))
      check('history 有 1 个采样点', usage.history().length === 1, String(usage.history().length))
      check(
        '采样值取自三个窗口',
        usage.history()[0]?.rolling === 5 && usage.history()[0]?.weekly === 15 && usage.history()[0]?.monthly === 7
      )
      const written = jsonlLines(historyPath('ok.jsonl'))
      check('historyFile 落盘一行', written.length === 1, `${written.length} 行`)
      check('落盘内容与采样一致', written[0]?.t === clock && written[0]?.weekly === 15)
      check(
        '凭证描述只说来源、不含密钥',
        usage.credentialLabel() === '环境变量 WB_TOKEN_METER_OPENCODE_KEY' && !usage.credentialLabel().includes(MOCK_KEY)
      )
    })

    /* 节流：最小间隔 60 秒，force 能顶开 */
    await withMockServer({ body: USAGE_BODY }, async (server) => {
      const usage = makeUsage(server.endpoint, 'throttle.jsonl')
      check('第一次 pull(true) 发请求', (await usage.pull(true)) === true && server.hits.length === 1, String(server.hits.length))
      check('同一时刻 pull(false) 被节流', (await usage.pull(false)) === false && server.hits.length === 1, String(server.hits.length))
      tick(61_000)
      check('过 60 秒 pull(false) 重新发请求', (await usage.pull(false)) === true && server.hits.length === 2, String(server.hits.length))
      check('pull(true) 无视节流强制再发', (await usage.pull(true)) === true && server.hits.length === 3, String(server.hits.length))
    })

    /* 退避：失败后 60 秒起，翻倍到 300 秒封顶；force 同样能顶开 */
    await withMockServer({ status: 500, body: '{"type":"error"}' }, async (server) => {
      const usage = makeUsage(server.endpoint, 'backoff.jsonl')
      check('HTTP 500 时 pull 返回 false', (await usage.pull(true)) === false)
      check('HTTP 500 的错误文案带状态码', (usage.current().error ?? '').includes('500'), String(usage.current().error))
      tick(30_000)
      check('失败后 30 秒内不重试', (await usage.pull(false)) === false && server.hits.length === 1, String(server.hits.length))
      tick(30_000)
      check('满 60 秒重试一次', (await usage.pull(false)) === false && server.hits.length === 2, String(server.hits.length))
      tick(90_000)
      check('第二次失败后退避翻倍到 120 秒', (await usage.pull(false)) === false && server.hits.length === 2, String(server.hits.length))
      tick(30_000)
      check('满 120 秒再重试', (await usage.pull(false)) === false && server.hits.length === 3, String(server.hits.length))
      check('pull(true) 无视退避', (await usage.pull(true)) === false && server.hits.length === 4, String(server.hits.length))
    })

    /* 并发去重：同一时刻两次 pull，只该有一个请求在飞 */
    await withMockServer({ body: USAGE_BODY, delayMs: 80 }, async (server) => {
      const usage = makeUsage(server.endpoint, 'inflight.jsonl')
      const [first, second] = await Promise.all([usage.pull(true), usage.pull(true)])
      check('并发两次 pull 只发一个请求', server.hits.length === 1, String(server.hits.length))
      check('两个调用拿到同一个结果', first === true && second === true)
      check(
        '请求结束后 in-flight 清空，还能再拉',
        (await usage.pull(true)) === true && server.hits.length === 2,
        String(server.hits.length)
      )
    })

    /* 401：从未成功过 vs 成功后失败，两种陈旧值语义 */
    await withMockServer({ status: 401, body: AUTH_ERROR_BODY }, async (server) => {
      const never = makeUsage(server.endpoint, 'never-ok.jsonl')
      check('401 时 pull 返回 false', (await never.pull(true)) === false)
      check('401 的错误文案提到凭证', (never.current().error ?? '').includes('凭证'), String(never.current().error))
      check('从未成功过时 stale 为 false', never.current().stale === false)
      check('从未成功过时 fetchedAt 为 0', never.current().fetchedAt === 0)
      check('失败不留下窗口、不写采样', never.current().windows.length === 0 && never.history().length === 0)

      const staleUsage = makeUsage(server.endpoint, 'stale.jsonl')
      server.setReply({ body: USAGE_BODY })
      check('先成功一次', (await staleUsage.pull(true)) === true)
      const goodAt = staleUsage.current().fetchedAt
      server.setReply({ status: 401, body: AUTH_ERROR_BODY })
      check('再失败一次', (await staleUsage.pull(true)) === false)
      const afterFail = staleUsage.current()
      check('成功后失败：stale 变 true', afterFail.stale === true)
      check(
        '成功后失败：旧窗口还留着',
        afterFail.windows.length === 3 && windowOf(afterFail.windows, 'weekly')?.percent === 15,
        String(afterFail.windows.length)
      )
      check('成功后失败：fetchedAt 还是上次成功时刻', afterFail.fetchedAt === goodAt, `${afterFail.fetchedAt} / ${goodAt}`)
      check('成功后失败：error 有值', (afterFail.error ?? '').length > 0, String(afterFail.error))
      check('成功后失败：已落盘的采样不受影响', staleUsage.history().length === 1, String(staleUsage.history().length))
    })

    /* 坏响应体：坏 JSON / 非 JSON / 空体 / 没有窗口，都不许抛 */
    await withMockServer({ body: '{ broken json' }, async (server) => {
      const usage = makeUsage(server.endpoint, 'bad-body.jsonl')
      const bodies = ['{ broken json', '<html>不是 JSON</html>', '', '{"usage":{}}', '{"usage":{"rolling":{"percent":"x"}}}']
      const results: boolean[] = []
      const errors: string[] = []
      let threw = false
      for (const body of bodies) {
        server.setReply({ body })
        try {
          results.push(await usage.pull(true))
        } catch {
          threw = true
          results.push(true)
        }
        errors.push(usage.current().error ?? '')
      }
      check('坏响应体不抛异常', !threw)
      check('坏响应体一律 pull=false', results.every((r) => r === false), results.join(','))
      check('每次都有 error 文案', errors.every((e) => e.length > 0), errors.join(' | '))
      check(
        '响应里没有窗口时文案说清楚',
        errors[3].includes('没有可用') && errors[4].includes('没有可用'),
        `${errors[3]} / ${errors[4]}`
      )
      check('坏响应不留下窗口', usage.current().windows.length === 0)
      check('坏响应不写采样', usage.history().length === 0)
    })

    /* 采样去重：值不变不重复记点，但每 30 分钟补一条心跳 */
    await withMockServer({ body: USAGE_BODY }, async (server) => {
      const usage = makeUsage(server.endpoint, 'dedup.jsonl')
      check('首次拉取记 1 个点', (await usage.pull(true)) === true && jsonlLines(historyPath('dedup.jsonl')).length === 1)
      tick(61_000)
      check(
        '值没变时再拉不重复记点',
        (await usage.pull(false)) === true && usage.history().length === 1,
        `${jsonlLines(historyPath('dedup.jsonl')).length} 行`
      )
      tick(31 * 60_000)
      check(
        '值没变但满 30 分钟，补一条心跳',
        (await usage.pull(false)) === true && usage.history().length === 2,
        `${jsonlLines(historyPath('dedup.jsonl')).length} 行`
      )
      server.setReply({
        body: JSON.stringify({ usage: { rolling: { percent: 40 }, weekly: { percent: 60 }, monthly: { percent: 80 } } })
      })
      tick(61_000)
      check(
        '值变了立刻记点',
        (await usage.pull(false)) === true && usage.history().length === 3,
        `${jsonlLines(historyPath('dedup.jsonl')).length} 行`
      )
      check('最新采样是变化后的值', usage.history()[2]?.rolling === 40 && usage.history()[2]?.monthly === 80)
    })

    /* 凭证：没有 auth.json / 坏 JSON / 缺 key 字段 / 合法 */
    await withMockServer({ body: USAGE_BODY }, async (server) => {
      const noKey = new OpencodeUsage({
        dir: opencodeRoot,
        historyFile: historyPath('no-key.jsonl'),
        endpoint: server.endpoint,
        now: () => clock
      })
      check('没有 auth.json 时 pull=false', (await noKey.pull(true)) === false)
      check('没有凭证的错误文案提到未找到', (noKey.current().error ?? '').includes('未找到'), String(noKey.current().error))
      check('没有凭证时一个请求都没发', server.hits.length === 0, String(server.hits.length))
      check(
        '没有凭证时凭证描述指向 auth.json',
        noKey.credentialLabel() === noKey.credentialFile && noKey.credentialFile.endsWith('auth.json')
      )

      const badAuth = new OpencodeUsage({
        dir: badAuthDir,
        historyFile: historyPath('bad-auth.jsonl'),
        endpoint: server.endpoint,
        now: () => clock
      })
      check('auth.json 是坏 JSON 时 pull=false', (await badAuth.pull(true)) === false)
      check('auth.json 是坏 JSON 时按「未找到」处理', (badAuth.current().error ?? '').includes('未找到'), String(badAuth.current().error))

      const noField = new OpencodeUsage({
        dir: noKeyFieldDir,
        historyFile: historyPath('no-field.jsonl'),
        endpoint: server.endpoint,
        now: () => clock
      })
      check('auth.json 缺 key 字段时 pull=false', (await noField.pull(true)) === false)

      const fromFile = new OpencodeUsage({
        dir: authDir,
        historyFile: historyPath('file-key.jsonl'),
        endpoint: server.endpoint,
        now: () => clock
      })
      check('auth.json 里的密钥被用上', (await fromFile.pull(true)) === true, String(fromFile.current().error))
      check('请求头用 auth.json 的密钥', server.hits[0]?.authorization === 'Bearer oc_from_file', server.hits[0]?.authorization ?? '(空)')
      check('只有合法凭证那次发了请求', server.hits.length === 1, String(server.hits.length))
    })

    /* 超时（毫秒级模拟）：产品给每次请求挂了 8 秒的 AbortSignal.timeout，
       这里注入的 fetch 按 undici 的方式立刻抛 TimeoutError，验证错误收口与退避；
       真等满 8 秒的那条在「健壮性」段里。 */
    {
      const seen: { url: string; signal: AbortSignal | null; gotSignal: boolean } = {
        url: '',
        signal: null,
        gotSignal: false
      }
      const instantTimeoutFetch: typeof fetch = (input, init) => {
        seen.url = String(input)
        seen.signal = init?.signal ?? null
        seen.gotSignal = init?.signal instanceof AbortSignal
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        return Promise.reject(error)
      }
      const usage = makeUsage(DEAD_ENDPOINT, 'timeout-injected.jsonl', { fetchImpl: instantTimeoutFetch })
      let threw = false
      let ok = true
      try {
        ok = await usage.pull(true)
      } catch {
        threw = true
      }
      check('超时：pull 不抛异常', !threw)
      check('超时：返回 false', ok === false)
      check('超时：请求打的是配置的端点', seen.url === DEAD_ENDPOINT, seen.url)
      check('超时：产品传了 abort 信号', seen.gotSignal && seen.signal !== null)
      check('超时：错误文案收口成「请求超时」', usage.current().error === '请求超时', String(usage.current().error))
      check('超时：不留下窗口', usage.current().windows.length === 0)
    }

    /* ----------------------------------------------- 真实数据模式 */

    section('OpenCode Go 真实数据')

    const opencodeDirPath = process.env['WB_TOKEN_METER_OPENCODE_DIR'] || join(homedir(), '.local', 'share', 'opencode')
    const opencodeAuthPath = join(opencodeDirPath, 'auth.json')
    console.log(`  凭证文件 ${opencodeAuthPath}`)

    if (!existsSync(opencodeAuthPath)) {
      console.log('  skip 未找到 OpenCode Go 凭证 —— 真实额度断言全部跳过（CI 环境属正常）')
    } else {
      /* 采样写到临时目录，别动应用自己的历史文件 */
      const realUsage = new OpencodeUsage({ dir: opencodeDirPath, historyFile: join(realHistoryRoot, 'usage.jsonl') })
      const realStarted = Date.now()
      const realOk = await realUsage.pull(true)
      const realElapsed = Date.now() - realStarted
      const realState = realUsage.current()
      if (!realOk) {
        console.log(`  skip 真实额度请求没成功（${realState.error}）—— 真实额度断言全部跳过（CI 环境属正常）`)
      } else {
        check('用默认端点', realUsage.endpoint === DEFAULT_USAGE_ENDPOINT, realUsage.endpoint)
        check('读到三个窗口', realState.windows.length === 3, String(realState.windows.length))
        check(
          '三个百分比都在 0..100',
          realState.windows.every((w) => w.percent >= 0 && w.percent <= 100),
          realState.windows.map((w) => w.percent).join('/')
        )
        check('fetchedAt > 0', realState.fetchedAt > 0, String(realState.fetchedAt))
        check('error 为空', realState.error === null, String(realState.error))
        check('请求在 15 秒内完成', realElapsed < 15_000, `${realElapsed} ms`)
        console.log(`  请求耗时 ${realElapsed} ms · ${quotaSummary(realState.windows, 'long')}`)
        check('采样落盘', jsonlLines(join(realHistoryRoot, 'usage.jsonl')).length === 1)
      }
    }

    /* --------------------------------------------------- 健壮性 */

    section('OpenCode Go 健壮性')

    const goneDir = join(opencodeRoot, 'does-not-exist', 'deeper')
    const goneUsage = new OpencodeUsage({
      dir: goneDir,
      historyFile: historyPath('gone.jsonl'),
      endpoint: DEAD_ENDPOINT,
      now: () => clock
    })
    let goneThrew = false
    let goneOk = true
    try {
      goneOk = await goneUsage.pull(true)
    } catch {
      goneThrew = true
    }
    check('dir 不存在时不抛异常', !goneThrew)
    check('dir 不存在时 pull=false', goneOk === false)
    check('dir 不存在时按「未找到凭证」处理', (goneUsage.current().error ?? '').includes('未找到'), String(goneUsage.current().error))

    /* historyFile 的父路径是个文件 —— 落盘必失败，但额度显示不能跟着挂 */
    const blocker = join(opencodeRoot, 'blocker.txt')
    writeFileSync(blocker, 'not a directory')
    await withMockServer({ body: USAGE_BODY }, async (server) => {
      const usage = new OpencodeUsage({
        dir: opencodeRoot,
        historyFile: join(blocker, 'quota.jsonl'),
        endpoint: server.endpoint,
        keyOverride: MOCK_KEY,
        now: () => clock
      })
      let threw = false
      let ok = true
      try {
        ok = await usage.pull(true)
      } catch {
        threw = true
      }
      check('采样写不进去时不抛异常', !threw)
      check('采样写不进去时额度照常更新', ok === true && usage.current().windows.length === 3)
      check('采样写不进去时内存里仍留着点', usage.history().length === 1, String(usage.history().length))
      check('采样写不进去时不会误建文件', !existsSync(join(blocker, 'quota.jsonl')))
    })

    /* 端点不可达（网络层失败）：不抛，也不能把进程拖死 */
    const unreachable = new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: historyPath('unreachable.jsonl'),
      endpoint: DEAD_ENDPOINT,
      keyOverride: MOCK_KEY,
      now: () => clock
    })
    let unreachableThrew = false
    let unreachableOk = true
    try {
      unreachableOk = await unreachable.pull(true)
    } catch {
      unreachableThrew = true
    }
    check('端点不可达时不抛异常', !unreachableThrew)
    check('端点不可达时 pull=false', unreachableOk === false)
    check('端点不可达时 error 有值', (unreachable.current().error ?? '').length > 0, String(unreachable.current().error))

    /* 注入的 fetch 抛非 Error 值也要收口 */
    const weirdFetch: typeof fetch = () => Promise.reject('boom')
    const weird = new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: historyPath('weird.jsonl'),
      endpoint: DEAD_ENDPOINT,
      keyOverride: MOCK_KEY,
      now: () => clock,
      fetchImpl: weirdFetch
    })
    check(
      'fetch 抛非 Error 值时 pull=false 且 error 有值',
      (await weird.pull(true)) === false && (weird.current().error ?? '').length > 0,
      String(weird.current().error)
    )

    /* 真等满 8 秒的超时：mock 服务停住不回包，产品自带的 AbortSignal.timeout 必须自己收口。
       这条会真的花掉 8 秒（产品常量），不为了跑得快去改产品代码。 */
    await withMockServer({ body: USAGE_BODY, delayMs: 12_000 }, async (server) => {
      const usage = makeUsage(server.endpoint, 'timeout-real.jsonl')
      const started = Date.now()
      let threw = false
      let ok = true
      try {
        ok = await usage.pull(true)
      } catch {
        threw = true
      }
      const elapsed = Date.now() - started
      check('真实超时：pull 不抛异常', !threw)
      check('真实超时：返回 false', ok === false)
      check('真实超时：8 秒左右自己收口', elapsed >= 7_000 && elapsed < 30_000, `${elapsed} ms`)
      check('真实超时：错误文案是「请求超时」', usage.current().error === '请求超时', String(usage.current().error))
      check('真实超时：mock 确实收到了请求', server.hits.length === 1, String(server.hits.length))
      check('真实超时：不留下窗口', usage.current().windows.length === 0)
    })

    /* historyFile 里混着坏行：只取合法的，不崩 */
    const dirtyHistory = historyPath('dirty.jsonl')
    writeFileSync(
      dirtyHistory,
      [
        JSON.stringify({ t: clock - 60_000, rolling: 1, weekly: 2, monthly: 3 }),
        'not json at all',
        '{"t":"x"}',
        JSON.stringify({ t: clock - 30_000, rolling: 4 }),
        ''
      ].join('\n')
    )
    const dirty = new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: dirtyHistory,
      endpoint: DEAD_ENDPOINT,
      keyOverride: MOCK_KEY,
      now: () => clock
    })
    check('historyFile 里的坏行被丢掉', dirty.history().length === 2, String(dirty.history().length))
    check(
      '缺字段的采样按 0 补齐',
      dirty.history()[1]?.rolling === 4 && dirty.history()[1]?.weekly === 0,
      JSON.stringify(dirty.history()[1])
    )

    /* --------------------------------------------- 多源隔离 */

    section('五个数据源互不影响')

    const sharedWbCache = new Map()
    const wbBefore = collectSnapshot({ workbuddyDir, cache: sharedWbCache, now: FIXED_NOW })
    const wbKeysBefore = [...sharedWbCache.keys()]
    const kimiCache = new Map()
    collectKimiSnapshot({ kimiDir, cache: kimiCache, now: FIXED_NOW })
    collectZcodeSnapshot({ zcodeDir: zcodeDirPath, now: FIXED_NOW })
    collectMimoSnapshot({ mimoDir: mimoDataPath, cacheDir: mimoCachePath, now: FIXED_NOW })

    /* OpenCode Go 是唯一会发请求的源，这里让它连失败两次：一次压根没有凭证（不发请求），
       一次打到没人监听的本地端口（网络层失败）。两次都不该动到另外四个源的缓存与快照。 */
    const isolatedNoKey = new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: historyPath('isolated-no-key.jsonl'),
      endpoint: DEAD_ENDPOINT,
      now: () => clock
    })
    check('隔离用例：没有凭证时拉取失败', (await isolatedNoKey.pull(true)) === false)
    check(
      '隔离用例：失败原因指向凭证文件',
      (isolatedNoKey.current().error ?? '').includes('未找到'),
      String(isolatedNoKey.current().error)
    )
    const isolatedUnreachable = new OpencodeUsage({
      dir: opencodeRoot,
      historyFile: historyPath('isolated-unreachable.jsonl'),
      endpoint: DEAD_ENDPOINT,
      keyOverride: MOCK_KEY,
      now: () => clock
    })
    check('隔离用例：端点不可达时拉取失败', (await isolatedUnreachable.pull(true)) === false)
    check(
      '隔离用例：失败后没有窗口、error 有值',
      isolatedUnreachable.current().windows.length === 0 && (isolatedUnreachable.current().error ?? '').length > 0
    )

    const wbAfter = collectSnapshot({ workbuddyDir, cache: sharedWbCache, now: FIXED_NOW })

    check('采集另外三个源之后 WorkBuddy 快照逐字节一致', JSON.stringify(wbBefore) === JSON.stringify(wbAfter))
    check('WorkBuddy 的解析缓存没被动过', JSON.stringify([...sharedWbCache.keys()]) === JSON.stringify(wbKeysBefore))
    check(
      'WorkBuddy 缓存里没有别的源的文件',
      wbKeysBefore.every(
        (key) =>
          !key.includes('.kimi-code') && !key.includes('.zcode') && !key.includes('mimocode') && !key.includes('opencode')
      )
    )
    check('Kimi 缓存里没有 WorkBuddy 的文件', [...kimiCache.keys()].every((key) => !key.includes('.workbuddy')))
    check(
      '五个源的 kind 各自正确',
      wbAfter.kind === 'workbuddy' &&
        kimiReal.kind === 'kimi' &&
        zcodeReal.kind === 'zcode' &&
        mimoReal.kind === 'mimo' &&
        sourceLabel('opencode') === 'OpenCode Go' &&
        SOURCE_ORDER.length === 5,
      SOURCE_ORDER.join('/')
    )
  } finally {
    rmSync(opencodeRoot, { recursive: true, force: true })
    rmSync(realHistoryRoot, { recursive: true, force: true })
  }
}

main()
  .catch((error: unknown) => {
    failed += 1
    console.error('  FAIL 测试脚本自身抛异常', error)
  })
  .finally(() => {
    /* --------------------------------------------------------------- 汇总 */

    console.log(`\n${passed} 通过 / ${failed} 失败`)
    if (failed > 0) process.exitCode = 1
  })

/* 需要类型引用，避免 CallRecord 被误判为未使用 */
export type { CallRecord }
