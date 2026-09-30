/**
 * Qoder CN 用量采集 —— 唯一一个「只有积分、没有 token」的本地源。
 *
 * 数据在 <qoderDir>/projects/<项目转义名>/<会话id>.jsonl（默认 ~/.qoder-cn）：
 * 一次模型请求 = 一组 assistant 行，其中最后一条带 message.usage：
 *
 *   {"credits":1.059814008,"original_credits":同值,"billable":true,
 *    "context_usage_ratio":0.0602625,"request_id":"…",
 *    "input_tokens":0,"output_tokens":0,
 *    "cache_read_input_tokens":0,"cache_creation_input_tokens":0,…}
 *
 * 四个 token 字段**恒为 0** —— 不是读不到，是 Qoder CN 服务端就不下发 token
 * （客户端自己的上下文快照里标着 tokenCountsAvailable:false，界面上的水位环
 * 也是按比例画的）。所以这个源没有 token 通道，界面按「积分 + 水位」那套画
 * ——见 format.ts 的 hasTokens()。
 *
 * 两个坑：
 *   1) 分支（fork）会话会把父会话的历史整段复制进自己的 jsonl，复制行带
 *      forkedFrom{sessionId,messageUuid} 标记、且行内 sessionId 会被改写成
 *      fork 会话自己。直接相加就把父会话的账重复算一遍（本机实测重复 154 次
 *      请求、约六成积分）。去重按 usage.request_id 全局进行，归属认
 *      forkedFrom.sessionId。
 *   2) 追加写的文件被强杀时尾部可能留下半行 —— 坏行直接跳过。
 *
 * 刻意不读 %APPDATA% 下的 main.sqlite：会话标题 / 模型窗口都在里面，但要处理
 * WAL 锁，而这里扫描 jsonl 已经够用（标题取文件里第一条真人输入）。
 * billable 字段的语义未明（false 的行也带 credits，且占本机九成以上），
 * 一律入账 —— 待与 Qoder 界面用量页对账后再定口径。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* -------------------------------------------------------------- 行形态 */

export interface QoderCallRow {
  /** 去重键：同一请求在 fork 会话里会有一份复制品，request_id 相同 */
  requestId: string
  /** 归属会话 —— fork 复制行归 forkedFrom.sessionId */
  sessionId: string
  /** 所在文件的会话；与 sessionId 不等即为 fork 复制行 */
  fileSessionId: string
  /** 行内记录的工作目录（复制行保留原值，父会话文件被清理时兜底） */
  cwd: string
  model: string
  timestamp: number
  credits: number
  /** 上下文水位 0..1，缺省 0 */
  contextRatio: number
}

export interface QoderFileData {
  /** 文件名的会话 id */
  sessionId: string
  /** 转义目录名（如 D--AI-github-wb-token-meter），项目维度的聚合键 */
  projectDir: string
  /** 会话标题：文件里第一条真人输入的文本 */
  title: string
  rows: QoderCallRow[]
}

interface QoderCacheEntry {
  mtimeMs: number
  size: number
  data: QoderFileData
}

export type QoderParseCache = Map<string, QoderCacheEntry>

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** ISO 时间串转毫秒时间戳；解析不了返回 0 */
function isoTime(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/* -------------------------------------------------------------- 解析 */

/**
 * 解析一行 usage 结算行。
 * 只有 assistant 行里那一条带 message.usage 的才算数（同组其余行没有 usage）；
 * 坏行、缺 request_id / 时间戳的行返回 null —— 强杀留下的半行不能把整本账带崩。
 */
export function parseQoderUsageLine(line: string): QoderCallRow | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const row = raw as Record<string, unknown>
  if (row.type !== 'assistant') return null
  const message = row.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  if (!message || !usage) return null

  const requestId = str(usage.request_id)
  const timestamp = isoTime(row.timestamp)
  if (!requestId || !timestamp) return null

  const forkedFrom = row.forkedFrom as Record<string, unknown> | undefined
  const fileSessionId = str(row.sessionId)
  return {
    requestId,
    sessionId: str(forkedFrom?.sessionId) || fileSessionId || 'qoder',
    fileSessionId,
    cwd: str(row.cwd),
    model: str(message.model) || '未知模型',
    timestamp,
    credits: num(usage.credits),
    // 水位比例夹到 0..1：界面的仪表与圆环都按 1 为满
    contextRatio: Math.min(1, Math.max(0, num(usage.context_usage_ratio)))
  }
}

/**
 * 解析一行真人输入，取会话标题。
 * fork 复制段里的 user 行跳过（带 forkedFrom）—— 标题要是本会话的第一句话。
 */
export function parseQoderTitleLine(line: string): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const row = raw as Record<string, unknown>
  if (row.type !== 'user' || !row.humanInput || row.forkedFrom) return null
  const message = row.message as Record<string, unknown> | undefined
  const content = message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = str((content[0] as Record<string, unknown> | undefined)?.text)
  if (!text) return null
  // 用户那句话可能是多行长文本 —— 压成一行再截断
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || null
}

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

/** 读一个会话文件；只追加写，靠 mtime + size 判断要不要重扫 */
export function readQoderFile(file: string, cache?: QoderParseCache): QoderFileData | null {
  const stat = statOf(file)
  if (!stat) return null
  const cached = cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const sessionId = basename(file, '.jsonl')
  const projectDir = basename(dirname(file))
  const rows: QoderCallRow[] = []
  let title = ''

  for (const line of text.split('\n')) {
    if (!line) continue
    // 预筛：只有 usage 行和真人输入行值得 JSON.parse —— 文件里绝大多数是
    // 消息体与工具结果，行又大，全量解析是白烧 CPU
    if (line.includes('"usage"')) {
      const row = parseQoderUsageLine(line)
      if (row) rows.push(row.fileSessionId ? row : { ...row, fileSessionId: sessionId })
    }
    if (!title && line.includes('"humanInput"')) {
      title = parseQoderTitleLine(line) ?? ''
    }
  }

  const data: QoderFileData = { sessionId, projectDir, title, rows }
  cache?.set(file, { ...stat, data })
  return data
}

/* -------------------------------------------------------------- 聚合 */

export interface QoderCollectOptions {
  /** 数据根目录，默认 ~/.qoder-cn；会话记录在 <dir>/projects/<项目>/ 下 */
  qoderDir: string
  cache?: QoderParseCache
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/** 扫 <qoderDir>/projects/ 下一层项目目录里的会话文件 */
function listSessionFiles(qoderDir: string): string[] {
  const root = join(qoderDir, 'projects')
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    let entries
    try {
      entries = readdirSync(join(root, dir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(root, dir.name, entry.name))
      }
    }
  }
  return files
}

/**
 * 读 <qoderDir> 并摊成一张 Snapshot。
 * 日 / 模型 / 项目 / 会话 / 活跃这些口径交给共用的 aggregate.buildSnapshot，
 * 积分随 CallRecord 逐笔进去。
 */
export function collectQoderSnapshot(options: QoderCollectOptions): Snapshot {
  const { qoderDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const files = listSessionFiles(qoderDir)
  if (!files.length) {
    warnings.push(`未读到 Qoder CN 会话记录（${join(qoderDir, 'projects')}），用量将显示为 0`)
  }

  const parsedFiles: QoderFileData[] = []
  for (const file of files) {
    const data = readQoderFile(file, cache)
    if (data) parsedFiles.push(data)
  }

  /*
   * 全局去重：fork 会话复制的历史与父会话的原生记录是同一 request_id。
   * 同键冲突时原生行优先（fileSessionId === sessionId）—— 父会话文件还在时
   * 保父的副本；父文件被清理后，fork 里的复制行照样入账（归 forkedFrom 会话）。
   */
  const uniqueRows = new Map<string, QoderCallRow>()
  for (const data of parsedFiles) {
    for (const row of data.rows) {
      const prev = uniqueRows.get(row.requestId)
      if (!prev) {
        uniqueRows.set(row.requestId, row)
        continue
      }
      const rowNative = row.fileSessionId === row.sessionId
      if (prev.fileSessionId !== prev.sessionId && rowNative) {
        uniqueRows.set(row.requestId, row)
      }
    }
  }

  // 会话元数据以原生文件为准（fork 复制行的归属是父会话，标题/项目别拿错）
  const meta = new Map<string, { title: string; cwd: string; projectDir: string }>()
  for (const data of parsedFiles) {
    meta.set(data.sessionId, {
      title: data.title,
      cwd: data.rows[0]?.cwd ?? '',
      projectDir: data.projectDir
    })
  }

  const callsBySession = new Map<string, CallRecord[]>()
  const lastRowBySession = new Map<string, QoderCallRow>()
  for (const row of uniqueRows.values()) {
    const info = meta.get(row.sessionId)
    const call: CallRecord = {
      // Qoder CN 没有要拿 traceId 对账的东西；requestId 就是账本主键
      traceId: '',
      conversationRequestId: row.requestId,
      sessionId: row.sessionId,
      projectDir: info?.projectDir || row.cwd || row.sessionId,
      model: row.model,
      timestamp: row.timestamp,
      // 四个 token 字段恒 0 —— 服务端只回积分，界面按 hasTokens('qoder') 收起
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      credits: row.credits
    }
    const list = callsBySession.get(row.sessionId)
    if (list) list.push(call)
    else callsBySession.set(row.sessionId, [call])

    const last = lastRowBySession.get(row.sessionId)
    if (!last || row.timestamp >= last.timestamp) lastRowBySession.set(row.sessionId, row)
  }

  const sessions: SourceSession[] = []
  for (const [sessionId, calls] of callsBySession) {
    const info = meta.get(sessionId)
    const last = lastRowBySession.get(sessionId)
    let lastActivity = 0
    for (const call of calls) {
      if (call.timestamp > lastActivity) lastActivity = call.timestamp
    }
    sessions.push({
      sessionId,
      // 父会话文件被清理时，fork 里的复制行照样出账，项目名从行内 cwd 兜底
      projectDir: info?.projectDir || calls[0].projectDir || sessionId,
      cwd: info?.cwd || '',
      title: info?.title ?? '',
      // 水位只报比例（会话最后一次请求的 context_usage_ratio）：
      // Qoder CN 不给 token 绝对值，估算出来的数字不如不报，
      // 面板与胶囊在 size 未知但有 ratio 时按比例画
      contextUsed: 0,
      contextSize: 0,
      contextRatio: last?.contextRatio || undefined,
      lastActivity,
      archived: false,
      calls
    })
  }

  return buildSnapshot(sessions, {
    kind: 'qoder',
    dir: qoderDir,
    files: parsedFiles.length,
    // 「账本行数」= 去重后的真实请求数（fork 复制品不算账）
    dbRows: uniqueRows.size,
    now,
    warnings
  })
}
