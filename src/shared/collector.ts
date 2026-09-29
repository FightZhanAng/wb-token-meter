import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  ActiveContext,
  CallRecord,
  DayStat,
  ModelStat,
  ProjectStat,
  SessionStat,
  Snapshot,
  TokenBundle,
  Totals
} from './types'

/* ------------------------------------------------------------------ 基础工具 */

export function emptyBundle(): TokenBundle {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
}

/** 把一次调用累加进一个 token 汇总 —— Kimi Code 采集器也用它（纯函数，无副作用） */
export function addCall(bundle: TokenBundle, call: CallRecord): void {
  bundle.calls += 1
  bundle.inputTokens += call.inputTokens
  bundle.outputTokens += call.outputTokens
  bundle.cachedTokens += call.cachedTokens
  bundle.reasoningTokens += call.reasoningTokens
}

/** 本地时区的 YYYY-MM-DD —— 用户看的是自己所在的「今天」 */
export function localDate(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* -------------------------------------------------------------- 单行解析 */

/**
 * 从一行 transcript 里抽出一次模型调用的用量。
 *
 * 数据形态（实测自本机 ~/.workbuddy/projects）：
 *   providerData.usage = {
 *     requests, inputTokens, outputTokens, totalTokens,
 *     inputTokensDetails:  [{ cached_tokens }],
 *     outputTokensDetails: [{ reasoning_tokens }]
 *   }
 * 同层的 providerData.traceId / conversationRequestId 是通往积分明细的钥匙，
 * model 是计费模型名 —— 见 billingKey() 里的口径说明。
 *
 * 绝大多数行不含 usage（file-history-snapshot / reasoning / function_call_result 等），
 * 所以先用字符串探测快速跳过，避免无谓的 JSON.parse。
 */
export function parseUsageLine(line: string, sessionId: string, projectDir: string): CallRecord | null {
  if (line.indexOf('"usage"') < 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, any>
  const provider = row.providerData
  if (!provider || typeof provider !== 'object') return null

  const usage = provider.usage
  if (!usage || typeof usage !== 'object') return null

  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0

  const sumDetail = (list: unknown, key: string): number => {
    if (!Array.isArray(list)) return 0
    let total = 0
    for (const entry of list) {
      if (entry && typeof entry === 'object') total += num((entry as Record<string, unknown>)[key])
    }
    return total
  }

  const inputTokens = num(usage.inputTokens)
  const outputTokens = num(usage.outputTokens)
  if (inputTokens === 0 && outputTokens === 0) return null

  return {
    traceId: typeof provider.traceId === 'string' ? provider.traceId : '',
    conversationRequestId:
      typeof provider.conversationRequestId === 'string' ? provider.conversationRequestId : '',
    sessionId,
    projectDir,
    model:
      (typeof provider.model === 'string' && provider.model) ||
      (typeof provider.requestModelId === 'string' && provider.requestModelId) ||
      '未知模型',
    timestamp: num(row.timestamp) || Date.now(),
    inputTokens,
    outputTokens,
    cachedTokens: sumDetail(usage.inputTokensDetails, 'cached_tokens'),
    reasoningTokens: sumDetail(usage.outputTokensDetails, 'reasoning_tokens')
  }
}

/* ------------------------------------------------------------ 计费键 */

/**
 * 一次调用对应哪个计费回合。
 *
 * workbuddy.db 的 `session_usage.credit_json` 是一张 `{计费键: 积分}` 表。
 * 2026-09 前后 WorkBuddy 把这张表的 key 从 `traceId` 换成了
 * `conversationRequestId`：
 *
 * - 老版本：两个字段同值，拿 traceId 去查能查到；
 * - 新版本：两者分离，拿 traceId 去查**永远查不到** ——
 *   症状就是「今日 0 积分、新会话 0 积分」，而累计总额又是对的。
 *
 * 所以优先用 conversationRequestId，缺失时退回 traceId（老数据兼容）。
 */
export function billingKey(call: CallRecord): string {
  return call.conversationRequestId || call.traceId
}

/**
 * 从 credit_json 里取这次调用的积分。
 * 两个键都试一遍，避免数据处在两种口径之间的过渡期时漏掉。
 */
function creditOf(credits: Record<string, number>, call: CallRecord): number | null {
  for (const key of [call.conversationRequestId, call.traceId]) {
    const value = key ? credits[key] : undefined
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/* ------------------------------------------------------------ 文件级解析 */

export interface FileParseResult {
  calls: CallRecord[]
  title: string
}

export type ParseCache = Map<string, { mtimeMs: number; size: number; result: FileParseResult }>

export function parseTranscriptFile(
  file: string,
  sessionId: string,
  projectDir: string,
  cache?: ParseCache
): FileParseResult {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { calls: [], title: '' }
  }

  const cached = cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { calls: [], title: '' }
  }

  const calls: CallRecord[] = []
  let title = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    if (!title && line.indexOf('"ai-title"') >= 0) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.aiTitle === 'string') title = parsed.aiTitle
      } catch {
        /* 忽略坏行 */
      }
    }
    if (line.indexOf('"usage"') < 0) continue
    const record = parseUsageLine(line, sessionId, projectDir)
    if (record) calls.push(record)
  }

  const result: FileParseResult = { calls, title }
  cache?.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  return result
}

/* --------------------------------------------------------- 目录扫描 */

export interface ScannedTranscript {
  sessionId: string
  projectDir: string
  calls: CallRecord[]
  title: string
}

/** 扫描 <workbuddyDir>/projects/<projectDir>/<sessionId>.jsonl 及其 subagents */
export function scanTranscripts(workbuddyDir: string, cache?: ParseCache): ScannedTranscript[] {
  const root = join(workbuddyDir, 'projects')
  if (!existsSync(root)) return []

  // 同一个会话常常既有 <id>.jsonl 又有 <id>/subagents/*.jsonl ——
  // 必须并成一条，否则会话列表里会出现两条同 id 的记录、积分还被劈成两半。
  const bySession = new Map<string, ScannedTranscript>()

  const merge = (sessionId: string, projectDir: string, calls: CallRecord[], title: string): void => {
    const existing = bySession.get(sessionId)
    if (existing) {
      if (calls.length) existing.calls.push(...calls)
      if (!existing.title && title) existing.title = title
      return
    }
    // 拷贝一份：calls 可能直接来自解析缓存，往后 push 会污染缓存
    bySession.set(sessionId, { sessionId, projectDir, calls: calls.slice(), title })
  }

  let projects: string[] = []
  try {
    projects = readdirSync(root)
  } catch {
    return []
  }

  for (const projectDir of projects) {
    const projectPath = join(root, projectDir)
    let entries
    try {
      entries = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const sessionId = entry.name.slice(0, -'.jsonl'.length)
        const parsed = parseTranscriptFile(join(projectPath, entry.name), sessionId, projectDir, cache)
        merge(sessionId, projectDir, parsed.calls, parsed.title)
        continue
      }

      // <sessionId>/subagents/agent-*.jsonl —— 子代理的调用也算真实消耗，
      // 归到父会话名下，但拿不到 ai-title（标题仍以父会话为准）。
      // 里面可能还有 agent-xxx/tool-results/ 这类目录，不含 jsonl，不用管。
      if (entry.isDirectory()) {
        const subDir = join(projectPath, entry.name, 'subagents')
        if (!existsSync(subDir)) continue
        let subFiles: string[] = []
        try {
          subFiles = readdirSync(subDir).filter((name) => name.endsWith('.jsonl'))
        } catch {
          continue
        }
        const merged: CallRecord[] = []
        for (const name of subFiles) {
          merged.push(...parseTranscriptFile(join(subDir, name), entry.name, projectDir, cache).calls)
        }
        merge(entry.name, projectDir, merged, '')
      }
    }
  }

  return [...bySession.values()].filter((session) => session.calls.length || session.title)
}

/* -------------------------------------------------------------- 数据库 */

interface UsageRow {
  sessionId: string
  used: number
  size: number
  updatedAt: number
  credits: Record<string, number>
}

interface SessionRow {
  id: string
  title: string
  cwd: string
  model: string
  status: string
  updatedAt: number
}

interface DatabaseRead {
  usage: UsageRow[]
  sessions: SessionRow[]
}

/**
 * workbuddy.db 带 -wal / -shm 三件套，且正被运行中的 WorkBuddy 持有。
 * 先尝试只读直开（最快，也能读到 WAL 里的最新数据）；
 * 不行就把三件套一起复制到临时目录再开 —— 副本上的数据同样完整。
 */
function readDatabase(dbPath: string): DatabaseRead {
  const attempt = (path: string): DatabaseRead | null => {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const usage = (db
        .prepare('SELECT session_id, used, size, updated_at, credit_json FROM session_usage')
        .all() as Record<string, unknown>[]).map((row) => {
        let credits: Record<string, number> = {}
        try {
          const parsed = JSON.parse(String(row.credit_json ?? '{}')) as Record<string, unknown>
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'number' && Number.isFinite(value)) credits[key] = value
          }
        } catch {
          credits = {}
        }
        return {
          sessionId: String(row.session_id),
          used: Number(row.used) || 0,
          size: Number(row.size) || 0,
          updatedAt: Number(row.updated_at) || 0,
          credits
        }
      })

      const sessions = (db
        .prepare('SELECT id, title, cwd, model, status, updated_at FROM sessions')
        .all() as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ''),
        cwd: String(row.cwd ?? ''),
        model: String(row.model ?? ''),
        status: String(row.status ?? ''),
        updatedAt: Number(row.updated_at) || 0
      }))

      return { usage, sessions }
    } catch {
      return null
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }

  const direct = attempt(dbPath)
  if (direct) return direct

  const dir = mkdtempSync(join(tmpdir(), 'wbtm-db-'))
  try {
    for (const ext of ['', '-wal', '-shm']) {
      const src = dbPath + ext
      if (existsSync(src)) copyFileSync(src, join(dir, basename(dbPath) + ext))
    }
    return attempt(join(dir, basename(dbPath))) ?? { usage: [], sessions: [] }
  } catch {
    return { usage: [], sessions: [] }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------- 聚合 */

/** 一个计费回合：一次结算，可能包含多轮工具调用 */
interface BillingRound {
  sessionId: string
  call: CallRecord
  credit: number
}

/**
 * 把 transcript 摊平成计费回合列表。
 *
 * 同一个计费键在一个会话里只算一次，否则「一回合多轮工具调用」会把积分
 * 放大好几倍。没有任何积分记录的回合直接跳过 —— 调用方只关心算得出钱的部分。
 */
function billingRounds(
  transcripts: ScannedTranscript[],
  usageMeta: Map<string, UsageRow>
): BillingRound[] {
  const out: BillingRound[] = []
  for (const transcript of transcripts) {
    const usageRow = usageMeta.get(transcript.sessionId)
    if (!usageRow) continue
    const seen = new Set<string>()
    for (const call of transcript.calls) {
      const key = billingKey(call)
      if (!key || seen.has(key)) continue
      const credit = creditOf(usageRow.credits, call)
      if (credit === null) continue
      seen.add(key)
      out.push({ sessionId: transcript.sessionId, call, credit })
    }
  }
  return out
}

export interface CollectOptions {
  workbuddyDir: string
  cache?: ParseCache
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

export function collectSnapshot(options: CollectOptions): Snapshot {
  const { workbuddyDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const transcripts = scanTranscripts(workbuddyDir, cache)
  const db = readDatabase(join(workbuddyDir, 'workbuddy.db'))
  if (!db.sessions.length && !db.usage.length) {
    warnings.push('未能读取 workbuddy.db，积分与上下文水位将显示为 0')
  }

  const sessionMeta = new Map(db.sessions.map((row) => [row.id, row]))
  const usageMeta = new Map(db.usage.map((row) => [row.sessionId, row]))

  const sessionStats: SessionStat[] = []
  const dayMap = new Map<string, DayStat>()
  const modelMap = new Map<string, ModelStat>()
  const projectMap = new Map<string, ProjectStat>()

  const totals: Totals = {
    ...emptyBundle(),
    credits: 0,
    attributedCredits: 0,
    unattributedCredits: 0,
    sessions: 0,
    traces: 0,
    matchedTraces: 0,
    dbTraces: 0
  }

  // 积分以 workbuddy.db 的计费记录为权威口径 —— 那是 WorkBuddy 自己结算的结果。
  // 少数 traceId 可能已经没有对应的 transcript（会话被清理过），
  // 这部分单独算「未归因」，不并进会话明细，免得总额凭空少一截。
  const creditTotals = new Map<string, number>()
  for (const row of db.usage) {
    for (const [traceId, value] of Object.entries(row.credits)) {
      if (!creditTotals.has(traceId)) creditTotals.set(traceId, value)
    }
  }
  const dbCreditTotal = round2([...creditTotals.values()].reduce((a, b) => a + b, 0))
  let attributedCredits = 0

  const todayBundle: TokenBundle & { credits: number } = { ...emptyBundle(), credits: 0 }
  const todayKey = localDate(now)

  // 同一个计费回合的积分只能计一次 —— 一个 conversationRequestId 下有多轮工具调用，
  // 子代理与父会话也可能重复出现
  const creditedKeys = new Set<string>()

  for (const transcript of transcripts) {
    const meta = sessionMeta.get(transcript.sessionId)
    const usageRow = usageMeta.get(transcript.sessionId)
    const credits = usageRow?.credits ?? {}

    const bundle = emptyBundle()
    const billingKeys = new Set<string>()
    const hitKeys = new Set<string>()
    let creditsForSession = 0
    let lastActivity = meta?.updatedAt ?? 0

    for (const call of transcript.calls) {
      addCall(bundle, call)
      if (call.timestamp > lastActivity) lastActivity = call.timestamp

      // 计费回合：同一个键只结算一次，而且只认数据库里真有记录的那些
      const key = billingKey(call)
      if (key) {
        billingKeys.add(key)
        const value = creditOf(credits, call)
        if (value !== null) {
          hitKeys.add(key)
          if (!creditedKeys.has(key)) {
            creditedKeys.add(key)
            creditsForSession += value
          }
        }
      }

      const dayKey = localDate(call.timestamp)
      let day = dayMap.get(dayKey)
      if (!day) {
        day = { ...emptyBundle(), date: dayKey, credits: 0 }
        dayMap.set(dayKey, day)
      }
      addCall(day, call)
      if (dayKey === todayKey) {
        addCall(todayBundle, call)
      }

      let model = modelMap.get(call.model)
      if (!model) {
        model = { ...emptyBundle(), model: call.model, credits: 0, sessions: 0 }
        modelMap.set(call.model, model)
      }
      addCall(model, call)
    }

    totals.calls += bundle.calls
    totals.inputTokens += bundle.inputTokens
    totals.outputTokens += bundle.outputTokens
    totals.cachedTokens += bundle.cachedTokens
    totals.reasoningTokens += bundle.reasoningTokens
    attributedCredits += creditsForSession
    totals.traces += billingKeys.size
    // 命中数：这个会话里能从数据库取到积分的计费回合个数
    totals.matchedTraces += hitKeys.size
    totals.sessions += 1

    const projectKey = transcript.projectDir
    let project = projectMap.get(projectKey)
    if (!project) {
      project = { ...emptyBundle(), projectDir: projectKey, cwd: meta?.cwd ?? '', sessions: 0 }
      projectMap.set(projectKey, project)
    }
    project.calls += bundle.calls
    project.inputTokens += bundle.inputTokens
    project.outputTokens += bundle.outputTokens
    project.cachedTokens += bundle.cachedTokens
    project.reasoningTokens += bundle.reasoningTokens
    project.sessions += 1

    sessionStats.push({
      sessionId: transcript.sessionId,
      title: meta?.title || transcript.title || '(未命名会话)',
      cwd: meta?.cwd ?? '',
      projectDir: transcript.projectDir,
      model: meta?.model || mostFrequentModel(transcript.calls),
      status: meta?.status ?? '',
      credits: round2(creditsForSession),
      totalTraces: billingKeys.size,
      matchedTraces: hitKeys.size,
      contextUsed: usageRow?.used ?? 0,
      contextSize: usageRow?.size ?? 0,
      lastActivity,
      ...bundle
    })
  }

  // 模型粒度与日粒度的积分都基于「计费回合」：把 transcript 按计费键去重，
  // 再带上数据库里这一回合的积分。一个回合下有多轮工具调用，
  // 直接逐次累加会把积分乘以调用次数。
  const rounds = billingRounds(transcripts, usageMeta)

  for (const [modelName, stat] of modelMap) {
    let credits = 0
    for (const round of rounds) {
      if (round.call.model === modelName) credits += round.credit
    }
    stat.credits = round2(credits)
    stat.sessions = countSessionsForModel(transcripts, modelName)
  }

  for (const round of rounds) {
    const dayKey = localDate(round.call.timestamp)
    const day = dayMap.get(dayKey)
    if (day) day.credits += round.credit
    if (dayKey === todayKey) todayBundle.credits += round.credit
  }

  for (const day of dayMap.values()) day.credits = round2(day.credits)
  todayBundle.credits = round2(todayBundle.credits)
  totals.credits = dbCreditTotal
  totals.attributedCredits = round2(attributedCredits)
  totals.unattributedCredits = round2(Math.max(0, dbCreditTotal - attributedCredits))
  totals.dbTraces = creditTotals.size

  // 数据库里有积分、本地却一条都对不上 —— 大概率是 WorkBuddy 又改了计费键的口径。
  // 这曾经真实发生过（traceId → conversationRequestId），值得留个显式提示。
  if (dbCreditTotal > 0 && attributedCredits === 0 && transcripts.length > 0) {
    warnings.push('积分明细与本地记录口径不一致，积分可能显示为 0')
  }

  // 当前活跃会话：优先「正在工作」的，其次最近活动的
  const activeSource =
    sessionStats.find((s) => s.status === 'working') ??
    [...sessionStats].sort((a, b) => b.lastActivity - a.lastActivity)[0] ??
    null

  const active: ActiveContext | null = activeSource
    ? {
        sessionId: activeSource.sessionId,
        title: activeSource.title,
        cwd: activeSource.cwd,
        used: activeSource.contextUsed,
        size: activeSource.contextSize,
        updatedAt: activeSource.lastActivity
      }
    : null

  return {
    kind: 'workbuddy',
    generatedAt: now,
    totals,
    today: todayBundle,
    sessions: sessionStats.sort((a, b) => b.lastActivity - a.lastActivity),
    days: [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
    models: [...modelMap.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    projects: [...projectMap.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    active,
    source: {
      dir: workbuddyDir,
      files: transcripts.length,
      dbRows: db.usage.length
    },
    warnings
  }
}

export function mostFrequentModel(calls: CallRecord[]): string {
  const count = new Map<string, number>()
  for (const call of calls) count.set(call.model, (count.get(call.model) ?? 0) + 1)
  let best = ''
  let bestCount = 0
  for (const [model, n] of count) {
    if (n > bestCount) {
      best = model
      bestCount = n
    }
  }
  return best
}

function countSessionsForModel(transcripts: ScannedTranscript[], model: string): number {
  let n = 0
  for (const transcript of transcripts) {
    if (transcript.calls.some((call) => call.model === model)) n += 1
  }
  return n
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
