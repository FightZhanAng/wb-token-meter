/**
 * Kimi Code 用量采集 —— 与 collector.ts（WorkBuddy）**各走各的链路**。
 *
 * 两边账本口径不同：WorkBuddy 有积分（token 是副产品，还能和积分逐回合对上），
 * Kimi Code 只有 token，没有积分这一层。所以这里是独立模块，只把结果交给
 * aggregate.buildSnapshot 汇总 —— 那份聚合是 Kimi 与 ZCode 共用的，
 * **不含 WorkBuddy**，动它碰不到 WorkBuddy 的统计。
 *
 * 数据形态（本机实测 2026-09，全部在本地，不联网）：
 *
 *   ~/.kimi-code/config.toml                             每个模型的上下文窗口
 *   ~/.kimi-code/sessions/<workspace>/<session>/
 *     state.json                                         标题 / cwd / 时间 / 归档标记
 *     agents/<agentId>/wire.jsonl                        每次模型请求的用量
 *
 * wire.jsonl 里一行 `usage.record` 就是一次模型调用：
 *
 *   {"type":"usage.record","agentId":"main",
 *    "model":"OpenCode Go/deepseek-v4.1-flash",
 *    "usage":{"inputOther":27728,"output":273,
 *             "inputCacheRead":1152,"inputCacheCreation":0},
 *    "usageScope":"turn","time":1790133260712}
 *
 * 四个字段互不重叠，所以：输入 = inputOther + inputCacheRead + inputCacheCreation，
 * 缓存命中 = inputCacheRead。一条 usage.record = 一次请求，直接求和即可，
 * 不用像 WorkBuddy 那样再拿 traceId 去数据库对积分。
 *
 * 同文件的 `token_counting.measured` 是上下文水位（当前上下文多少 token），
 * 对应 WorkBuddy 那边的 used；窗口上限来自 config.toml 的 max_context_size。
 *
 * 子代理（agents/<id>，state.json 里 type=sub）各写各的 wire.jsonl。
 * 与 WorkBuddy 的处理一致：算真实消耗，但归到父会话名下。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* -------------------------------------------------------------- 基础工具 */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/* -------------------------------------------------------------- 单行解析 */

/**
 * 从 wire.jsonl 的一行里抽出一次模型调用的 token 用量。
 *
 * Kimi Code 不单列思考 token（已含在 output 里），也没有 traceId 这一层，
 * 所以 reasoningTokens / traceId 恒为空。
 */
export function parseKimiUsageLine(
  line: string,
  sessionId: string,
  workspaceDir: string
): CallRecord | null {
  if (line.indexOf('"usage.record"') < 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, any>
  if (row.type !== 'usage.record') return null

  const usage = row.usage
  if (!usage || typeof usage !== 'object') return null

  const inputTokens =
    num(usage.inputOther) + num(usage.inputCacheRead) + num(usage.inputCacheCreation)
  const outputTokens = num(usage.output)
  if (inputTokens === 0 && outputTokens === 0) return null

  return {
    traceId: '',
    sessionId,
    projectDir: workspaceDir,
    model: typeof row.model === 'string' && row.model ? row.model : '未知模型',
    timestamp: num(row.time) || Date.now(),
    inputTokens,
    outputTokens,
    cachedTokens: num(usage.inputCacheRead),
    reasoningTokens: 0
  }
}

/** 一行 token_counting.measured —— 上下文水位的一次测量 */
export function parseKimiContextLine(line: string): { tokens: number; time: number } | null {
  if (line.indexOf('"token_counting.measured"') < 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const row = parsed as Record<string, any>
  if (row.type !== 'token_counting.measured') return null

  const tokens = num(row.tokens)
  if (tokens <= 0) return null
  return { tokens, time: num(row.time) }
}

/* ------------------------------------------------------------ 文件级解析 */

export interface KimiSessionMeta {
  sessionId: string
  cwd: string
  title: string
  updatedAt: number
  archived: boolean
}

export interface KimiWireParse {
  calls: CallRecord[]
  /** 最后一次上下文测量值 */
  contextTokens: number
  contextAt: number
}

/** 一份缓存表同时管 wire.jsonl 与 state.json，键是文件绝对路径 */
interface KimiCacheEntry extends KimiWireParse {
  mtimeMs: number
  size: number
  meta: KimiSessionMeta | null
}

export type KimiParseCache = Map<string, KimiCacheEntry>

const emptyWire = (): KimiWireParse => ({ calls: [], contextTokens: 0, contextAt: 0 })

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 命中缓存就直接复用；没命中则给一个只填了 stat 的空壳，由调用方补齐内容 */
function readCached(
  file: string,
  cache?: KimiParseCache
): { entry: KimiCacheEntry; fresh: boolean } | null {
  const stat = statOf(file)
  if (!stat) return null
  const cached = cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { entry: cached, fresh: true }
  }
  return { entry: { ...stat, ...emptyWire(), meta: null }, fresh: false }
}

function store(file: string, entry: KimiCacheEntry, cache?: KimiParseCache): void {
  cache?.set(file, entry)
}

/**
 * 解析一个 wire.jsonl。
 * 会话记录会一直追加，靠 mtime + size 判断要不要重扫（与 WorkBuddy 同一套思路）。
 */
export function readKimiWire(
  file: string,
  sessionId: string,
  workspaceDir: string,
  cache?: KimiParseCache
): KimiWireParse {
  const hit = readCached(file, cache)
  if (!hit) return emptyWire()
  if (hit.fresh) return hit.entry

  const text = readText(file)
  if (text === null) return emptyWire()

  const calls: CallRecord[] = []
  let contextTokens = 0
  let contextAt = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.indexOf('"usage.record"') >= 0) {
      const call = parseKimiUsageLine(line, sessionId, workspaceDir)
      if (call) calls.push(call)
      continue
    }
    if (line.indexOf('"token_counting.measured"') >= 0) {
      const sample = parseKimiContextLine(line)
      if (sample) {
        contextTokens = sample.tokens
        contextAt = sample.time
      }
    }
  }

  const parsed: KimiCacheEntry = { ...hit.entry, calls, contextTokens, contextAt, meta: null }
  store(file, parsed, cache)
  return parsed
}

export function parseKimiState(text: string): KimiSessionMeta | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const row = parsed as Record<string, unknown>
  const title =
    (typeof row.title === 'string' && row.title) ||
    (typeof row.lastPrompt === 'string' && row.lastPrompt) ||
    ''

  return {
    sessionId: typeof row.id === 'string' ? row.id : '',
    cwd: typeof row.cwd === 'string' ? row.cwd : '',
    // 标题常常就是用户那句 prompt，可能是多行长文本 —— 压成一行再截断
    title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    updatedAt: num(row.updatedAt),
    archived: row.archived === true
  }
}

export function readKimiState(file: string, cache?: KimiParseCache): KimiSessionMeta | null {
  const hit = readCached(file, cache)
  if (!hit) return null
  if (hit.fresh) return hit.entry.meta

  const text = readText(file)
  if (text === null) return null
  const meta = parseKimiState(text)
  store(file, { ...hit.entry, meta }, cache)
  return meta
}

/* -------------------------------------------------------------- 目录扫描 */

export interface KimiAgentScan {
  agentId: string
  calls: CallRecord[]
}

export interface KimiSessionScan {
  sessionId: string
  workspaceDir: string
  cwd: string
  title: string
  archived: boolean
  updatedAt: number
  /** 主代理的上下文水位；子代理各有一份自己的小上下文，不参与水位 */
  contextTokens: number
  agents: KimiAgentScan[]
}

export interface KimiScanResult {
  sessions: KimiSessionScan[]
  /** 扫到的 wire.jsonl 个数 */
  files: number
}

/**
 * 扫描 <kimiDir>/sessions/<workspace>/<session> 下的 state.json 与
 * agents/<agentId>/wire.jsonl。没有 state.json 的目录（sessions/.index-cache 之类）直接跳过。
 */
export function scanKimiSessions(kimiDir: string, cache?: KimiParseCache): KimiScanResult {
  const root = join(kimiDir, 'sessions')
  const out: KimiSessionScan[] = []
  let files = 0
  if (!existsSync(root)) return { sessions: out, files }

  let workspaces: string[] = []
  try {
    workspaces = readdirSync(root)
  } catch {
    return { sessions: out, files }
  }

  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace)
    let sessionDirs
    try {
      sessionDirs = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue

      const sessionPath = join(workspacePath, dir.name)
      const statePath = join(sessionPath, 'state.json')
      if (!existsSync(statePath)) continue

      const meta = readKimiState(statePath, cache)
      const sessionId = meta?.sessionId || dir.name

      const agentsDir = join(sessionPath, 'agents')
      let agentDirs
      try {
        agentDirs = readdirSync(agentsDir, { withFileTypes: true })
      } catch {
        continue
      }

      const agents: KimiAgentScan[] = []
      let contextTokens = 0
      // wire.jsonl 里的最后测量时间：state.json 偶尔滞后，用它兜住「最后活动」
      let wireAt = 0

      for (const agent of agentDirs) {
        if (!agent.isDirectory()) continue
        const wire = join(agentsDir, agent.name, 'wire.jsonl')
        if (!existsSync(wire)) continue

        files += 1
        const parsed = readKimiWire(wire, sessionId, workspace, cache)
        if (parsed.calls.length) agents.push({ agentId: agent.name, calls: parsed.calls })
        if (parsed.contextAt > wireAt) wireAt = parsed.contextAt
        if (agent.name === 'main') contextTokens = parsed.contextTokens
      }

      // 一个调用都没有的会话（只开过没说话）不进列表，免得排行榜全是空行
      if (!agents.length) continue

      out.push({
        sessionId,
        workspaceDir: workspace,
        cwd: meta?.cwd ?? '',
        title: meta?.title ?? '',
        archived: meta?.archived ?? false,
        updatedAt: Math.max(meta?.updatedAt ?? 0, wireAt),
        contextTokens,
        agents
      })
    }
  }

  return { sessions: out, files }
}

/* ------------------------------------------------------------ 上下文窗口 */

/**
 * 从 config.toml 里取每个模型的上下文窗口。
 *
 * 只认 [models."<别名>"] 段下的 max_context_size，其余内容（包括凭据）一律不看，
 * 也就不用为此引一个 TOML 解析器 —— 这个文件是用户自己的配置，读进来只为这一项。
 */
export function parseModelContextSizes(toml: string): Map<string, number> {
  const sizes = new Map<string, number>()
  let current: string | null = null

  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      const section = /^\[models\."([^"]+)"\]$/.exec(line) ?? /^\[models\.([^\]]+)\]$/.exec(line)
      current = section ? section[1] : null
      continue
    }
    if (!current) continue
    const kv = /^max_context_size\s*=\s*(\d+)/.exec(line)
    if (kv) sizes.set(current, Number(kv[1]))
  }

  return sizes
}

function readModelContextSizes(file: string): Map<string, number> {
  const text = readText(file)
  return text ? parseModelContextSizes(text) : new Map()
}

/* -------------------------------------------------------------- 聚合 */

export interface KimiCollectOptions {
  kimiDir: string
  cache?: KimiParseCache
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 扫描 ~/.kimi-code 并摊成一张 Snapshot。
 *
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot，
 * 这里只负责把 wire.jsonl 的形态翻译成 SourceSession。
 */
export function collectKimiSnapshot(options: KimiCollectOptions): Snapshot {
  const { kimiDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const scan = scanKimiSessions(kimiDir, cache)
  if (!existsSync(join(kimiDir, 'sessions'))) {
    warnings.push(`未找到 Kimi Code 会话目录（${join(kimiDir, 'sessions')}），用量将显示为 0`)
  }
  const contextSizes = readModelContextSizes(join(kimiDir, 'config.toml'))

  const sessions: SourceSession[] = scan.sessions.map((session) => {
    const calls = session.agents.flatMap((agent) => agent.calls)
    // 上下文窗口按「最后用的模型」算：会话中途换过模型时，水位要对着当前这个
    const lastModel = calls.length ? calls[calls.length - 1].model : ''
    return {
      sessionId: session.sessionId,
      projectDir: session.workspaceDir,
      cwd: session.cwd,
      title: session.title,
      contextUsed: session.contextTokens,
      contextSize: contextSizes.get(lastModel) ?? 0,
      lastActivity: session.updatedAt,
      archived: session.archived,
      calls
    }
  })

  return buildSnapshot(sessions, {
    kind: 'kimi',
    dir: kimiDir,
    files: scan.files,
    dbRows: 0,
    now,
    warnings
  })
}
