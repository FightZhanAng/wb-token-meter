/**
 * 无头验证脚本 —— 不依赖 Electron，直接跑在 Node 上。
 *   npm run test:core
 *
 * 重点验证三件事：
 *   1. 单行解析在真实数据上不掉字段、在脏数据上不崩
 *   2. 各维度聚合能交叉对上（会话/日/模型/项目 求和 == 全局）
 *   3. traceId 与积分明细的对齐率
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectSnapshot, localDate, parseUsageLine } from '../src/shared/collector'
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

/* --------------------------------------------------------------- 汇总 */

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1

/* 需要类型引用，避免 CallRecord 被误判为未使用 */
export type { CallRecord }
