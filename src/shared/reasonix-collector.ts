/**
 * Reasonix 用量采集 —— 六个本地源里最直白的一份。
 *
 * Reasonix（桌面端与 CLI 共用一套引擎）每次模型调用往同一本流水账上追加一行：
 *
 *   ~/.reasonix/usage.jsonl
 *     {"ts":…,"session":"code-Agent","model":"deepseek-v4-flash",
 *      "promptTokens":12910,"completionTokens":730,
 *      "cacheHitTokens":0,"cacheMissTokens":12910,
 *      "costUsd":…,"claudeEquivUsd":…}
 *   ~/.reasonix/sessions/<会话名>.meta.json
 *     {"summary":"…","workspace":"D:\\Agent","lastPromptTokens":174186,…}
 *
 * 口径（实测 promptTokens === cacheHitTokens + cacheMissTokens 恒成立，
 * 1799 行无例外）：
 *   输入 = promptTokens（**含缓存读**，与 WorkBuddy / Kimi / ZCode 同向）
 *   缓存命中 = cacheHitTokens
 *   输出 = completionTokens
 * 没有思考 token 这一项 —— 引擎把它算进 completionTokens 里了，
 * 所以界面上「· 思考」整行收起（与 Kimi Code 同样处理）。
 *
 * 本模块**刻意不读 ~/.reasonix/config.json**：那里面存着明文 apiKey，
 * 而本工具需要的标题 / 工作目录 / 上下文水位在 meta.json 里都有。
 *
 * 两处已知边界：
 *   1) 流水账的 `session` 字段只写当前活着的那个会话名。会话被归档时
 *      （sessions/<名>__archive_<时间>.jsonl）历史行仍留在同一个名字下，
 *      所以归档会话的用量会并进它原来的名字里，拆不开。
 *   2) 上下文上限拿不到（引擎的模型目录不落本地），水位只报已用量。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* -------------------------------------------------------------- 行形态 */

export interface ReasonixCallRow {
  sessionId: string
  model: string
  timestamp: number
  /** 完整输入 = cacheHit + cacheMiss */
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface ReasonixSessionMeta {
  title: string
  workspace: string
  /** 最后一次请求的 prompt 大小 —— 那正是当前上下文 */
  lastPromptTokens: number
}

/** 一份缓存表同时管 usage.jsonl 与 *.meta.json，键是文件绝对路径 */
interface ReasonixCacheEntry {
  mtimeMs: number
  size: number
  rows: ReasonixCallRow[]
  meta: ReasonixSessionMeta | null
}

export type ReasonixParseCache = Map<string, ReasonixCacheEntry>

const emptyEntry = (): ReasonixCacheEntry => ({ mtimeMs: 0, size: 0, rows: [], meta: null })

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/* -------------------------------------------------------------- 解析 */

/**
 * 解析流水账的一行。坏行、缺时间戳的行、一点 token 都没有的行都返回 null ——
 * 追加写的文件被强杀时尾部可能留下半行，不能让半行把整本账带崩。
 */
export function parseReasonixUsageLine(line: string): ReasonixCallRow | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const row = raw as Record<string, unknown>
  const timestamp = num(row.ts)
  if (!timestamp) return null

  const inputTokens = num(row.promptTokens)
  const outputTokens = num(row.completionTokens)
  // 与其它源一致：一次调用至少得留下点 token，否则不进账（也免得排行榜全是空行）
  if (inputTokens <= 0 && outputTokens <= 0) return null

  return {
    sessionId: str(row.session) || 'reasonix',
    model: str(row.model) || '未知模型',
    timestamp,
    inputTokens,
    outputTokens,
    cachedTokens: num(row.cacheHitTokens)
  }
}

/** 解析会话元数据。只取标题 / 工作目录 / 上下文水位三项，别的字段一概不看 */
export function parseReasonixMeta(text: string): ReasonixSessionMeta | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const row = raw as Record<string, unknown>
  return {
    // summary 常常就是用户那句话，可能是多行长文本 —— 压成一行再截断
    title: str(row.summary).replace(/\s+/g, ' ').trim().slice(0, 200),
    workspace: str(row.workspace),
    lastPromptTokens: num(row.lastPromptTokens)
  }
}

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

function readCached(
  file: string,
  cache?: ReasonixParseCache
): { entry: ReasonixCacheEntry; fresh: boolean } | null {
  const stat = statOf(file)
  if (!stat) return null
  const cached = cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { entry: cached, fresh: true }
  }
  return { entry: { ...emptyEntry(), ...stat }, fresh: false }
}

function store(file: string, entry: ReasonixCacheEntry, cache?: ReasonixParseCache): void {
  cache?.set(file, entry)
}

/** 读 usage.jsonl；流水账只追加，靠 mtime + size 判断要不要重扫 */
export function readReasonixLedger(file: string, cache?: ReasonixParseCache): ReasonixCallRow[] {
  const hit = readCached(file, cache)
  if (!hit) return []
  if (hit.fresh) return hit.entry.rows

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const rows: ReasonixCallRow[] = []
  for (const line of text.split('\n')) {
    const row = parseReasonixUsageLine(line)
    if (row) rows.push(row)
  }

  store(file, { ...hit.entry, rows }, cache)
  return rows
}

export function readReasonixMeta(file: string, cache?: ReasonixParseCache): ReasonixSessionMeta | null {
  const hit = readCached(file, cache)
  if (!hit) return null
  if (hit.fresh) return hit.entry.meta

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const meta = parseReasonixMeta(text)
  store(file, { ...hit.entry, meta }, cache)
  return meta
}

/* -------------------------------------------------------------- 聚合 */

export interface ReasonixCollectOptions {
  reasonixDir: string
  cache?: ReasonixParseCache
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/** 扫 sessions/ 下所有 *.meta.json，键是会话名（文件名去掉后缀） */
function readSessionMetas(
  reasonixDir: string,
  cache?: ReasonixParseCache
): { metas: Map<string, ReasonixSessionMeta>; files: number } {
  const metas = new Map<string, ReasonixSessionMeta>()
  const dir = join(reasonixDir, 'sessions')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { metas, files: 0 }
  }

  let files = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue
    files += 1
    const meta = readReasonixMeta(join(dir, entry.name), cache)
    if (meta) metas.set(entry.name.slice(0, -'.meta.json'.length), meta)
  }
  return { metas, files }
}

/**
 * 读 ~/.reasonix 并摊成一张 Snapshot。
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot。
 */
export function collectReasonixSnapshot(options: ReasonixCollectOptions): Snapshot {
  const { reasonixDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const ledgerPath = join(reasonixDir, 'usage.jsonl')
  const rows = readReasonixLedger(ledgerPath, cache)
  if (!rows.length) {
    warnings.push(`未读到 Reasonix 用量流水（${ledgerPath}），用量将显示为 0`)
  }

  const { metas, files: metaFiles } = readSessionMetas(reasonixDir, cache)

  // 上下文水位 = 会话最后一次请求的 prompt；流水账本身不带上下文测量，
  // 所以只认 meta.json 的 lastPromptTokens，拿不到就留 0（界面只报已用）
  const lastRequest = new Map<string, ReasonixCallRow>()
  const callsBySession = new Map<string, CallRecord[]>()
  for (const row of rows) {
    const previous = lastRequest.get(row.sessionId)
    if (!previous || row.timestamp >= previous.timestamp) lastRequest.set(row.sessionId, row)

    const call: CallRecord = {
      // Reasonix 没有要拿 traceId 对账的东西
      traceId: '',
      sessionId: row.sessionId,
      projectDir: metas.get(row.sessionId)?.workspace || row.sessionId,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      // 引擎没有单列思考 token，这一项恒为 0，界面按 hasReasoning('reasonix') 收起
      reasoningTokens: 0
    }
    const list = callsBySession.get(row.sessionId)
    if (list) list.push(call)
    else callsBySession.set(row.sessionId, [call])
  }

  const sessions: SourceSession[] = []
  for (const [sessionId, calls] of callsBySession) {
    const info = metas.get(sessionId)
    sessions.push({
      sessionId,
      // 按工作目录分组：会话名（code-Agent / desktop-…）跟项目没关系
      projectDir: info?.workspace || sessionId,
      cwd: info?.workspace ?? '',
      title: info?.title ?? '',
      contextUsed: info?.lastPromptTokens ?? lastRequest.get(sessionId)?.inputTokens ?? 0,
      // 引擎的模型目录不落本地，窗口留 0，界面只报已用
      contextSize: 0,
      lastActivity: calls[calls.length - 1].timestamp,
      // 归档会话的用量并进了原会话名（见文件头），这里不标归档，
      // 否则「当前活跃会话」会选不出任何东西
      archived: false,
      calls
    })
  }

  return buildSnapshot(sessions, {
    kind: 'reasonix',
    dir: reasonixDir,
    files: metaFiles + (rows.length ? 1 : 0),
    dbRows: rows.length,
    now,
    warnings
  })
}
