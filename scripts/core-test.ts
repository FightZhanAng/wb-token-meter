/**
 * 无头验证脚本 —— 不依赖 Electron，直接跑在 Node 上。
 *   npm run test:core
 *
 * 重点验证三件事：
 *   1. 单行解析在真实数据上不掉字段、在脏数据上不崩
 *   2. 各维度聚合能交叉对上（会话/日/模型/项目 求和 == 全局）
 *   3. traceId 与积分明细的对齐率
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSnapshot, localDate, parseUsageLine } from '../src/shared/collector'
import {
  collectKimiSnapshot,
  parseKimiContextLine,
  parseKimiState,
  parseKimiUsageLine,
  parseModelContextSizes
} from '../src/shared/kimi-collector'
import { compact, grouped, percent, tokenPerCredit } from '../src/shared/format'
import type { CallRecord, Snapshot } from '../src/shared/types'

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

section('两个数据源互不影响')

const sharedWbCache = new Map()
const wbBefore = collectSnapshot({ workbuddyDir, cache: sharedWbCache, now: FIXED_NOW })
const wbKeysBefore = [...sharedWbCache.keys()]
const kimiCache = new Map()
collectKimiSnapshot({ kimiDir, cache: kimiCache, now: FIXED_NOW })
const wbAfter = collectSnapshot({ workbuddyDir, cache: sharedWbCache, now: FIXED_NOW })

check('采集 Kimi Code 后 WorkBuddy 快照逐字节一致', JSON.stringify(wbBefore) === JSON.stringify(wbAfter))
check('WorkBuddy 的解析缓存没被动过', JSON.stringify([...sharedWbCache.keys()]) === JSON.stringify(wbKeysBefore))
check('WorkBuddy 缓存里没有 Kimi 的文件', wbKeysBefore.every((key) => !key.includes('.kimi-code')))
check('Kimi 缓存里没有 WorkBuddy 的文件', [...kimiCache.keys()].every((key) => !key.includes('.workbuddy')))
check(
  'WorkBuddy 快照的 kind 没被带偏',
  wbAfter.kind === 'workbuddy' && kimiReal.kind === 'kimi'
)

/* --------------------------------------------------------------- 汇总 */

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1

/* 需要类型引用，避免 CallRecord 被误判为未使用 */
export type { CallRecord }
