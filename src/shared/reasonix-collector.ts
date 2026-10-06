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
 *      就停在池子名上。但会话的**元信息**在兄弟目录里能借到 —— 两代落盘位置都得看，
 *      引擎在 2026-10 换了地方，只认老目录会让「当前活跃会话」永远停在最后一个老会话上：
 *        · 老位置 desktop-sessions-v5/by-id/<会话>/：header.json 带 cwd，
 *          events.frames 的 mtime 定「最近有动静」；界面库
 *          desktop/session-ui-v1.sqlite 的 submission 记录带用户原文 —— 会话名
 *          就是首条用户输入，照 same 规矩取来当标题。这套自 2026-10-01 21:54 起停写。
 *        · 新位置 projects/<项目 slug>/sessions/<时间戳>-<模型>.jsonl：标题取配套
 *          .jsonl.meta 的 preview，cwd 要从正文开头注入的 system 提示里提（没有
 *          header.json）。谁最后有动静谁代表活跃会话。
 *      两块合起来只影响「当前活跃会话」那格的显示。
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
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
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

/** 一份缓存表同时管 usage.jsonl、*.meta.json 与 *.wire.jsonl，键是文件绝对路径 */
interface ReasonixCacheEntry {
  mtimeMs: number
  size: number
  rows: ReasonixCallRow[]
  meta: ReasonixSessionMeta | null
  /** 只有 *.wire.jsonl 会填这一项：按会话的调用账 */
  wire?: ReasonixWireUsage[]
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
  /** 会话正文最后一次写入 —— 「最近有动静的会话」就是它最大的那个 */
  lastWrite: number
  /** 会话标题（.jsonl.meta 的 preview ＝首条用户输入） */
  title?: string
  /** 会话正文文件；cwd 要按需从它的开头提 */
  sourceFile?: string
  /** wire 里的调用账；没有 wire 文件就是空（老会话，或引擎换了格式） */
  usages?: ReasonixWireUsage[]
}





/* ------------------------------------------- 新版按会话的调用账（wire） */

/**
 * wire 里的一条 usage —— 引擎每调一次模型就往 <会话>.wire.jsonl 追一条。
 *
 * 这是**唯一带会话归属**的账：官方按天账本（stats/<日期>.jsonl）只有
 * day/source/model，归不到会话，所有调用只能挤进一个池子 —— 于是「两个会话
 * 各自用了多少」根本答不出来，界面上一栏只能显示一条假会话（用户报的就是这个）。
 *
 * 与官方账本同源：实测 2026-10-06 那天两边 185 行按四个 token 数逐行一一对应，
 * 一个不多一个不少 —— 所以拿它做**会话归属**、拿官方账本做**时间**，各取所长。
 */
export interface ReasonixWireUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  /** 模型引用（<provider>/<model>）；嵌在 usage.costQuote.modelRef 里 */
  model: string
}

/**
 * 解析 wire.jsonl 的一行。这个文件里绝大多数行跟用量无关
 * （stream_attempt / tool_dispatch / tool_result / message / turn_*），
 * 只有 kind === 'usage' 的是账。坏行返回 null（追加写被强杀会留半行）。
 */
export function parseReasonixWireLine(line: string): ReasonixWireUsage | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const record = raw as { kind?: unknown; usage?: unknown }
  if (record.kind !== 'usage' || !record.usage || typeof record.usage !== 'object') return null
  const usage = record.usage as Record<string, unknown>

  const inputTokens = num(usage.promptTokens)
  const outputTokens = num(usage.completionTokens)
  // 与其它源一致：一次调用至少得留下点 token，否则不进账
  if (inputTokens <= 0 && outputTokens <= 0) return null

  // 模型名嵌在 costQuote 里（usage 本身没有 model 字段）；取不到就留空，
  // 上层会退回会话级模型
  const quote = (usage.costQuote ?? {}) as Record<string, unknown>
  return {
    inputTokens,
    outputTokens,
    cachedTokens: num(usage.cacheHitTokens),
    reasoningTokens: num(usage.reasoningTokens),
    model: str(quote.modelRef)
  }
}

/** 读一份 wire.jsonl。引擎哪天换了格式也只会读到空表 —— 上层退回「一个池子」的老行为 */
function readWireUsages(file: string, cache?: ReasonixParseCache): ReasonixWireUsage[] {
  const hit = readCached(file, cache)
  if (!hit) return []
  if (hit.fresh) return hit.entry.wire ?? []

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const usages: ReasonixWireUsage[] = []
  for (const line of text.split('\n')) {
    const usage = parseReasonixWireLine(line)
    if (usage) usages.push(usage)
  }

  store(file, { ...hit.entry, wire: usages }, cache)
  return usages
}

/** 认领用的键：一次调用的四个 token 数 —— 官方账本与 wire 唯一重合的东西 */
function usageSig(input: number, output: number, cached: number, reasoning: number): string {
  return `${input}|${output}|${cached}|${reasoning}`
}

/**
 * 把官方账本的行按 token 值「认领」给 wire 会话。
 *
 * 为什么靠值认领：官方账本没有会话字段，wire 没有时间戳 —— 两边唯一的共同点
 * 就是每次调用的四个 token 数。实测同一天两边逐行对应（185 ↔ 185），认领得
 * 干干净净；值撞车时归属可能分错，但**总量永远守恒**（认领是消费式的，一行
 * 只归一个会话）。认领后的行沿用它自己的时间戳，所以天 / 活跃分布照旧是准的。
 */
function claimStatsRows(
  statsRows: ReasonixCallRow[],
  sessions: Map<string, DesktopSessionInfo>
): { poolRows: ReasonixCallRow[]; claimedBySession: Map<string, ReasonixCallRow[]> } {
  const claims = new Map<string, string[]>()
  for (const [sessionId, info] of sessions) {
    for (const usage of info.usages ?? []) {
      const key = usageSig(usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.reasoningTokens)
      const bucket = claims.get(key)
      if (bucket) bucket.push(sessionId)
      else claims.set(key, [sessionId])
    }
  }

  const poolRows: ReasonixCallRow[] = []
  const claimedBySession = new Map<string, ReasonixCallRow[]>()
  for (const row of statsRows) {
    const key = usageSig(row.inputTokens, row.outputTokens, row.cachedTokens, row.reasoningTokens)
    const bucket = claims.get(key)
    const owner = bucket && bucket.length ? bucket.pop() : undefined
    if (!owner) {
      poolRows.push(row)
      continue
    }
    const claimed: ReasonixCallRow = { ...row, sessionId: owner }
    const list = claimedBySession.get(owner)
    if (list) list.push(claimed)
    else claimedBySession.set(owner, [claimed])
  }
  return { poolRows, claimedBySession }
}

/* -------------------------------------- 新版（2.x）按项目落盘的会话 */

/**
 * 从新版会话的 .jsonl.meta 里取标题。桌面端的会话名就是首条用户输入，
 * 这份配套文件把它以 preview 的形式记下来了。
 */
export function parseReasonixSessionPreview(text: string): string {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return ''
  }
  if (!raw || typeof raw !== 'object') return ''
  // preview 长了会带省略号，压成一行即可 —— 与老账的 summary 同样处理
  return str((raw as Record<string, unknown>).preview).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * 从会话正文的一行里提工作目录。新版会话没有 header.json，cwd 只出现在
 * `Current workspace: "<路径>"` 那一段，而那段是被注入到**首条 user 消息**里的
 * （system 那条反而不带）。这一段的路径在正文里多转义了一层，双反斜杠要还原。
 */
export function parseReasonixMessageWorkspace(line: string): string {
  if (!line) return ''
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return ''
  }
  if (!raw || typeof raw !== 'object') return ''
  const content = (raw as { content?: unknown }).content
  if (typeof content !== 'string') return ''
  const match = content.match(/Current workspace:\s*"([^"\n]+)"/)
  if (!match) return ''
  return match[1].replace(/\\\\/g, '\\')
}

/** 只读文件开头 —— 会话正文几百 KB，要的东西在前几行 */
function readFileHead(file: string, bytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 读都失败了，关不上也没别的办法 */
      }
    }
  }
}

/** 从会话正文开头几行里提 cwd —— 注入落在首条 user 消息上，所以不能只看首行 */
function readSessionWorkspace(file: string): string {
  for (const line of readFileHead(file, 256 * 1024).split('\n').slice(0, 8)) {
    const cwd = parseReasonixMessageWorkspace(line)
    if (cwd) return cwd
  }
  return ''
}

/**
 * 扫新版（2.x）的会话目录：<home>/projects/<项目 slug>/sessions/<会话 id>.jsonl。
 *
 * 一次会话落成一组文件：正文 <id>.jsonl、配套 <id>.jsonl.meta（标题与模型）、
 * 事件流 .events.jsonl / .wire.jsonl，另有 .ckpt / .blobs 等目录。
 * 判据是**旁边有同名 .jsonl.meta** —— 有它才算一次正式会话。
 *
 * 标题取 meta 的 preview（＝首条用户输入）；调用账取隔壁的 wire（见上）；
 * cwd 不在这里读 —— 它藏在正文开头，只对真正有调用的会话按需提一次。
 */
function readProjectSessions(
  desktopRoot: string,
  cache?: ReasonixParseCache
): Map<string, DesktopSessionInfo> {
  const sessions = new Map<string, DesktopSessionInfo>()
  let projects
  try {
    projects = readdirSync(join(desktopRoot, 'projects'), { withFileTypes: true })
  } catch {
    return sessions
  }

  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith('.')) continue
    const dir = join(desktopRoot, 'projects', project.name, 'sessions')
    let files
    try {
      files = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      if (file.name.endsWith('.events.jsonl') || file.name.endsWith('.wire.jsonl')) continue
      const path = join(dir, file.name)
      const stat = statOf(path)
      if (!stat) continue
      let title: string
      try {
        title = parseReasonixSessionPreview(readFileSync(`${path}.meta`, 'utf8'))
      } catch {
        continue // 没有配套 meta 的 .jsonl 不是一次正式会话
      }
      const sessionId = file.name.slice(0, -'.jsonl'.length)
      sessions.set(sessionId, {
        sessionId,
        cwd: '',
        lastWrite: stat.mtimeMs,
        title,
        sourceFile: path,
        usages: readWireUsages(join(dir, `${sessionId}.wire.jsonl`), cache)
      })
    }
  }
  return sessions
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

  const { metas, files: metaFiles } = readSessionMetas(reasonixDir, cache)

  // 官方按天账本没有会话字段 —— 靠 wire 的调用账按 token 值逐行认领：
  // 认出来的归各自会话，认不出来的（旧版写的那些天，或 wire 读不到）留在池子里
  let poolRows = stats.rows
  let contextWindows = new Map<string, number>()
  const sessionRows: ReasonixCallRow[] = []
  if (statsDir) {
    // 新版桌面端的家当都在同一个根下（stats/ 的父目录），不再单开一个选项
    const desktopRoot = dirname(statsDir)
    const projectSessions = readProjectSessions(desktopRoot, cache)
    const claimed = claimStatsRows(stats.rows, projectSessions)
    poolRows = claimed.poolRows
    for (const [sessionId, claimedRows] of claimed.claimedBySession) {
      const info = projectSessions.get(sessionId)
      if (!info) continue
      // 有调用的会话才算真会话：给它备一份 meta，标题 / cwd / 上下文水位一次给齐。
      // cwd 藏在正文开头，只对有调用的会话读一次 —— 没调用的会话不必碰正文
      const usages = info.usages ?? []
      metas.set(sessionId, {
        title: info.title ?? '',
        workspace: info.cwd || (info.sourceFile ? readSessionWorkspace(info.sourceFile) : ''),
        // 上下文水位 = 最后一次请求的 prompt —— 那正是当前上下文
        lastPromptTokens: usages.length ? usages[usages.length - 1].inputTokens : 0
      })
      sessionRows.push(...claimedRows)
    }
    // 模型窗口同样在桌面端根下；读不到就全体留 0，界面退回「只报已用量」
    try {
      contextWindows = parseReasonixContextWindows(readFileSync(join(desktopRoot, 'config.toml'), 'utf8'))
    } catch {
      /* 没有配置文件不算错误 —— 老版本引擎本来就不落模型目录 */
    }
  }

  const rows = [...ledgerRows, ...poolRows, ...sessionRows]
  if (!rows.length) {
    const where = statsDir ? `${ledgerPath} 与 ${statsDir}` : ledgerPath
    warnings.push(`未读到 Reasonix 用量流水（${where}），用量将显示为 0`)
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
    // 池子 = 认领不出去的那些调用（旧版写的天，或 wire 读不出来时的兜底）。
    // 它没有会话归属，再借别人的名字就是指鹿为马 —— 给个能一眼认出来的名字
    const isPool = !info && sessionId.startsWith('reasonix-')
    // 「当前上下文」的窗口按最后一次请求的模型算 —— 那正是正在用的那个模型；
    // 老账的模型名不带 provider 前缀（旧引擎的模型目录不落本地），查不到就留 0
    const lastModel = lastRequest.get(sessionId)?.model ?? ''
    sessions.push({
      sessionId,
      // 按工作目录分组：会话名（code-Agent / desktop-…）跟项目没关系
      projectDir: info?.workspace || sessionId,
      cwd: info?.workspace ?? '',
      title: isPool ? '历史记录（无会话归属）' : (info?.title ?? ''),
      contextUsed: info?.lastPromptTokens ?? lastRequest.get(sessionId)?.inputTokens ?? 0,
      contextSize: contextWindows.get(lastModel) ?? 0,
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
