/**
 * Reasonix 用量采集 —— 六个本地源里最直白的一份。
 *
 * 引擎有**两本账**，都得读：
 *
 * 老账本（2026-06 前的桌面端与 CLI；最后一行实测停在 2026-05-24）：
 *
 *   ~/.reasonix/usage.jsonl
 *     {"ts":…,"session":"code-Agent","model":"deepseek-v4-flash",
 *      "promptTokens":12910,"completionTokens":730,
 *      "cacheHitTokens":0,"cacheMissTokens":12910,
 *      "costUsd":…,"claudeEquivUsd":…}
 *   ~/.reasonix/sessions/<会话名>.meta.json
 *     {"summary":"…","workspace":"D:\\Agent","lastPromptTokens":174186,…}
 *
 * 新账本（2026-06 起的桌面端新版换了落盘位置与行格式，按天一份）：
 *
 *   <appData>/reasonix/stats/<YYYY-MM-DD>.jsonl
 *     {"ts":"2026-10-01T21:19:48.2452108+08:00","source":"desktop",
 *      "model":"opencode-go-…/deepseek-flash",
 *      "prompt":103428,"completion":1414,"reasoning":1103,
 *      "cache_hit":97152,"cache_miss":6276,"total":104842,"requests":1,…}
 *
 * 口径（两本账同向，实测都成立）：
 *   输入 = prompt(Tokens)（**含缓存读**，与 WorkBuddy / Kimi / ZCode 同向；
 *          新账本少数早期行没记缓存字段，视作全 miss）
 *   缓存命中 = cacheHit(Tokens) / cache_hit
 *   输出 = completion(Tokens)（含思考：新账本 total === prompt + completion 恒成立）
 *   思考 = 新账本开始单记 reasoning，是输出的子集，界面上做「输出」的从属行；
 *          老账本没有这一项（恒 0）
 *
 * 新账本的三处边界：
 *   1) 行里**没有 session 字段**，聚合库（cache/usage-catalog 的 sqlite）也只到
 *      day/source/model 为止 —— 调用没法归到具体会话，所有调用按 `source`
 *      落进 `reasonix-<source>` 一个池子（当前是 reasonix-desktop），项目维度
 *      就停在池子名上。但会话的**元信息**在兄弟目录里能借到：
 *      desktop-sessions-v5/by-id/<会话>/header.json 带 cwd，events.frames 的
 *      mtime 定「最近有动静」；界面库 desktop/session-ui-v1.sqlite 的
 *      submission 记录带用户原文 —— 界面的会话名就是首条用户输入，照 same
 *      规矩取来当池子的标题（只影响「当前活跃会话」那格的显示）。
 *   2) "turn":true 的是回合边界标记行，不带 token 字段，解析时跳过。
 *   3) `requests` 目前恒为 1（一次调用一行）；哪天出现聚合行，调用数会少算。
 *
 * 本模块**刻意不读 ~/.reasonix/config.json**：那里面存着明文 apiKey，
 * 而本工具需要的标题 / 工作目录 / 上下文水位在 meta.json 里都有。
 *
 * 老账本的两处已知边界：
 *   1) 流水账的 `session` 字段只写当前活着的那个会话名。会话被归档时
 *      （sessions/<名>__archive_<时间>.jsonl）历史行仍留在同一个名字下，
 *      所以归档会话的用量会并进它原来的名字里，拆不开。
 *   2) 老账的模型名不带 provider 前缀、旧引擎的模型目录不落本地，上下文上限
 *      拿不到，窗口留 0；新账池子从桌面端 config.toml 的 providers 解析窗口
 *      （见「模型上下文窗口」），按最后一次请求的模型算。
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* -------------------------------------------------------------- 行形态 */

export interface ReasonixCallRow {
  sessionId: string
  model: string
  timestamp: number
  /** 完整输入 = cacheHit + cacheMiss（老账本恒成立；新账本没记缓存的行视作全 miss） */
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** 思考 token：新账本单记且含在输出里；老账本没有，恒 0 */
  reasoningTokens: number
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
    cachedTokens: num(row.cacheHitTokens),
    // 引擎把思考折进 completionTokens，老账本不单记这一项
    reasoningTokens: 0
  }
}

/**
 * 解析新版按天流水的一行。与老账本最大的不同：
 * `ts` 是 ISO 8601 字符串（带 7 位小数秒与时区，Date.parse 直接吃得下），
 * "turn":true 的是回合边界标记行（不带 token），要在这里拦掉。
 */
export function parseReasonixStatsLine(line: string): ReasonixCallRow | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const row = raw as Record<string, unknown>
  // 回合边界标记行不是一次调用；它不带 token 字段，留着会被当成 0 输入的空行
  if (row.turn === true) return null

  // 时间戳按 ISO 字符串为主，兼容数字（epoch ms）—— 万一哪天又换回数值
  const timestamp =
    typeof row.ts === 'number' ? row.ts : typeof row.ts === 'string' ? Date.parse(row.ts) : NaN
  if (!Number.isFinite(timestamp) || !timestamp) return null

  const inputTokens = num(row.prompt)
  const outputTokens = num(row.completion)
  // 与老账本一致：一次调用至少得留下点 token，否则不进账
  if (inputTokens <= 0 && outputTokens <= 0) return null

  return {
    // 新账本没有 session 字段；行里哪天补上了就并进同名会话，没有就按 source 落池
    sessionId: str(row.session) || `reasonix-${str(row.source) || 'desktop'}`,
    model: str(row.model) || '未知模型',
    timestamp,
    inputTokens,
    outputTokens,
    cachedTokens: num(row.cache_hit),
    reasoningTokens: num(row.reasoning)
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

/** 读新版按天流水的一份；同样是只追加的文件，靠 mtime + size 判断要不要重扫 */
export function readReasonixStatsLedger(file: string, cache?: ReasonixParseCache): ReasonixCallRow[] {
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
    const row = parseReasonixStatsLine(line)
    if (row) rows.push(row)
  }

  store(file, { ...hit.entry, rows }, cache)
  return rows
}

/**
 * 扫新版按天流水目录（<appData>/reasonix/stats）。文件名是 <YYYY-MM-DD>.jsonl，
 * 字典序即时间序；目录不存在（老版本 / CI / 没装桌面端）就是空，不报错。
 */
function readStatsRows(statsDir: string, cache?: ReasonixParseCache): { rows: ReasonixCallRow[]; files: number } {
  let entries
  try {
    entries = readdirSync(statsDir, { withFileTypes: true })
  } catch {
    return { rows: [], files: 0 }
  }

  let files = 0
  const rows: ReasonixCallRow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    files += 1
    rows.push(...readReasonixStatsLedger(join(statsDir, entry.name), cache))
  }
  return { rows, files }
}

/* ------------------------------------------------- 新版桌面端的会话元信息 */

interface DesktopSessionInfo {
  sessionId: string
  cwd: string
  /** events.frames 最后一次写入 —— 「最近有动静的会话」就是它最大的那个 */
  lastWrite: number
}

/**
 * 扫新版桌面端的会话目录（<appData>/reasonix/desktop-sessions-v5/by-id）。
 * 每个会话一个子目录：header.json 带 cwd，events.frames 是只追加的事件流
 * （私有容器格式，不解析内容，只 stat 它的 mtime 当活跃时刻）。
 * 目录不存在 / 是老版本就返回空表，不报错。
 */
function readDesktopSessions(desktopRoot: string): Map<string, DesktopSessionInfo> {
  const byId = join(desktopRoot, 'desktop-sessions-v5', 'by-id')
  let entries
  try {
    entries = readdirSync(byId, { withFileTypes: true })
  } catch {
    return new Map()
  }

  const sessions = new Map<string, DesktopSessionInfo>()
  for (const entry of entries) {
    // 点开头的（.content-v1 / .query-cache …）是配套存储，不是会话
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(byId, entry.name)
    let cwd = ''
    try {
      const header = JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')) as { cwd?: unknown }
      if (typeof header?.cwd === 'string') cwd = header.cwd
    } catch {
      /* 没有头文件的会话照样参与活跃评选，cwd 留空 */
    }
    let lastWrite = 0
    try {
      lastWrite = statSync(join(dir, 'events.frames')).mtimeMs
    } catch {
      /* 连事件流都没写过的会话轮不到「最近活跃」 */
    }
    sessions.set(entry.name, { sessionId: entry.name, cwd, lastWrite })
  }
  return sessions
}

/**
 * 从界面库（<appData>/reasonix/desktop/session-ui-v1.sqlite）挖会话标题。
 * 库里没有标题栏 —— 桌面端的会话名就是首条用户输入，submission 记录的
 * contentJson.text 带原文，按 revision 最低的那条取。库被锁 / 不存在返回空表。
 */
function readDesktopTitles(desktopRoot: string): Map<string, string> {
  const titles = new Map<string, string>()
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(join(desktopRoot, 'desktop', 'session-ui-v1.sqlite'), { readOnly: true })
    const rows = db
      .prepare("SELECT key, payload FROM records WHERE kind = 'submission'")
      .all() as Array<{ key: string; payload: string | Uint8Array }>

    const first = new Map<string, { revision: number; text: string }>()
    for (const row of rows) {
      let record: { ref?: { sessionId?: unknown }; revision?: unknown; contentJson?: unknown }
      try {
        const text = typeof row.payload === 'string' ? row.payload : new TextDecoder().decode(row.payload)
        record = JSON.parse(text)
      } catch {
        continue
      }
      const sessionId = typeof record.ref?.sessionId === 'string' ? record.ref.sessionId : ''
      if (!sessionId) continue
      const content = typeof record.contentJson === 'string' ? record.contentJson : ''
      let prompt = ''
      try {
        const parsed = JSON.parse(content) as { text?: unknown }
        if (typeof parsed.text === 'string') prompt = parsed.text.replace(/\s+/g, ' ').trim()
      } catch {
        continue
      }
      if (!prompt) continue
      // revision 是字符串数字；取最小的（＝最早的那句话），缺失的视为无穷大永不参选
      const parsed = Number.parseInt(String(record.revision ?? ''), 10)
      const revision = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
      const prev = first.get(sessionId)
      if (!prev || revision < prev.revision) {
        first.set(sessionId, { revision, text: prompt })
      }
    }

    for (const [sessionId, entry] of first) {
      titles.set(sessionId, entry.text.slice(0, 200))
    }
  } catch {
    return new Map()
  } finally {
    db?.close()
  }
  return titles
}

/* ------------------------------------------------------- 模型上下文窗口 */

/**
 * 从新版桌面端的 config.toml 提取每个模型的上下文窗口，键是 stats 流水里
 * model 字段的原样引用（<provider>/<model>）。窗口按优先级取：
 * provider 的 model_overrides[<model>].context_window > provider 的 context_window。
 *
 * 刻意不引完整 TOML 解析器（本机加依赖要过删除安全垫，见 AGENTS.md）：
 * 只按机器生成的形状做针对性提取 —— name / models / context_window 每个 provider
 * 块内首次出现的就是本块的，行内表（model_overrides）的值按花括号配对数出来，
 * 它的字符串值里不会有花括号（实测只有 psd 哈希与枚举名）。
 */
export function parseReasonixContextWindows(text: string): Map<string, number> {
  const windows = new Map<string, number>()
  const blocks = text.split(/^\s*\[\[providers\]\]/m).slice(1)
  for (const block of blocks) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
    if (!name) continue
    const defaultMatch = block.match(/^\s*context_window\s*=\s*(\d+)/m)
    const defaultWindow = defaultMatch ? Number(defaultMatch[1]) : 0
    const modelList = block.match(/^\s*models\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
    const models = [...modelList.matchAll(/"([^"]+)"/g)].map((piece) => piece[1])

    for (const model of models) {
      if (defaultWindow > 0) windows.set(`${name}/${model}`, defaultWindow)
    }

    const overrides = block.match(/^\s*model_overrides\s*=\s*\{/m)
    if (!overrides || overrides.index === undefined) continue
    const table = balancedBraces(block, overrides.index + overrides[0].length - 1)
    if (!table) continue
    for (const entry of table.matchAll(/"([^"]+)"\s*=\s*\{/g)) {
      const body = entry.index === undefined ? null : balancedBraces(table, entry.index + entry[0].length - 1)
      /* 行内表是单行的，体内不能再锚行首；provider 级那条必须锚行首，
         免得匹配到 model_overrides 里同名的键 */
      const window = body ? body.match(/context_window\s*=\s*(\d+)/)?.[1] : undefined
      if (window && Number(window) > 0) windows.set(`${name}/${entry[1]}`, Number(window))
    }
  }
  return windows
}

/** 数花括号找配对的收口；找不到（截断 / 括号不平衡）返回 null */
function balancedBraces(text: string, openIndex: number): string | null {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, index)
    }
  }
  return null
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
  /**
   * 新版桌面端的按天流水目录（<appData>/reasonix/stats）。
   * 不传就只读老账本 —— 两本账互不重叠（老账停在 2026-05-24，新账从 2026-08-04 起），
   * 直接把行并在一起交给孩子聚合。
   */
  statsDir?: string
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
  const { reasonixDir, statsDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const ledgerPath = join(reasonixDir, 'usage.jsonl')
  const ledgerRows = readReasonixLedger(ledgerPath, cache)
  const stats = statsDir ? readStatsRows(statsDir, cache) : { rows: [], files: 0 }
  const rows = [...ledgerRows, ...stats.rows]
  if (!rows.length) {
    const where = statsDir ? `${ledgerPath} 与 ${statsDir}` : ledgerPath
    warnings.push(`未读到 Reasonix 用量流水（${where}），用量将显示为 0`)
  }

  const { metas, files: metaFiles } = readSessionMetas(reasonixDir, cache)

  // 新账池子的标题 / cwd 从桌面端的会话目录借：调用归不到具体会话，
  // 但「当前活跃会话」显示的就是最近有动静的那一个
  let desktopSessions = new Map<string, DesktopSessionInfo>()
  let desktopTitles = new Map<string, string>()
  let desktopActiveId = ''
  let contextWindows = new Map<string, number>()
  if (statsDir) {
    // 新版桌面端的家当都在同一个根下（stats/ 的父目录），不再单开一个选项
    const desktopRoot = dirname(statsDir)
    desktopSessions = readDesktopSessions(desktopRoot)
    desktopTitles = readDesktopTitles(desktopRoot)
    let newest = 0
    for (const [id, info] of desktopSessions) {
      if (info.lastWrite >= newest) {
        newest = info.lastWrite
        desktopActiveId = id
      }
    }
    // 模型窗口同样在桌面端根下；读不到就全体留 0，界面退回「只报已用量」
    try {
      contextWindows = parseReasonixContextWindows(readFileSync(join(desktopRoot, 'config.toml'), 'utf8'))
    } catch {
      /* 没有配置文件不算错误 —— 老版本引擎本来就不落模型目录 */
    }
  }

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
      conversationRequestId: '',
      sessionId: row.sessionId,
      projectDir: metas.get(row.sessionId)?.workspace || row.sessionId,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      // 老账本恒 0；新账本单记思考（含在输出里），照实进账
      reasoningTokens: row.reasoningTokens
    }
    const list = callsBySession.get(row.sessionId)
    if (list) list.push(call)
    else callsBySession.set(row.sessionId, [call])
  }

  const sessions: SourceSession[] = []
  for (const [sessionId, calls] of callsBySession) {
    const info = metas.get(sessionId)
    // 新账池子（reasonix-<source>，没有 meta）借最近活跃桌面会话的标题与 cwd；
    // 老账会话有自己的 meta，一概不借
    const isPool = !info && sessionId.startsWith('reasonix-')
    const desktop = isPool ? desktopSessions.get(desktopActiveId) : undefined
    // 「当前上下文」的窗口按最后一次请求的模型算 —— 那正是正在用的那个模型；
    // 老账的模型名不带 provider 前缀（旧引擎的模型目录不落本地），查不到就留 0
    const lastModel = lastRequest.get(sessionId)?.model ?? ''
    sessions.push({
      sessionId,
      // 按工作目录分组：会话名（code-Agent / desktop-…）跟项目没关系
      projectDir: info?.workspace || sessionId,
      cwd: info?.workspace ?? desktop?.cwd ?? '',
      title: isPool ? (desktopTitles.get(desktopActiveId) ?? '') : (info?.title ?? ''),
      contextUsed: info?.lastPromptTokens ?? lastRequest.get(sessionId)?.inputTokens ?? 0,
      contextSize: isPool ? (contextWindows.get(lastModel) ?? 0) : 0,
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
    files: metaFiles + (ledgerRows.length ? 1 : 0) + stats.files,
    dbRows: rows.length,
    now,
    warnings
  })
}
