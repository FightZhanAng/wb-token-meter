/**
 * DeepSeek Harness 桌面端用量采集。
 *
 * DSH 把每个会话的事件流落成一个**多帧 zstd** 文件：
 *
 *   ~/.dsh/sessions/<工作目录转义名>/<session-id>/session.v4.jsonl.zstd
 *   ~/.dsh/storages/workspace.json        归档会话 id 列表
 *
 * 文件名的版本号是「格式世代」，不是副本：同一代里只写一个文件，
 * 换格式时另起一个名字接着写。本机实测三种世代并存
 * （`session.jsonl.zstd` / `.v3` / `.v4`），所以每个会话目录**只认版本号最高的那个**，
 * 全读会把同一段用量算好几遍。
 *
 * 用量记在 `assistant/message` 的 `data.usage` 上（v3/v4 形态）；
 * 更早的格式除此之外还会把同一次用量另发一遍 `assistant/chunk`（`chunk.type === "usage"`），
 * 两份**完全同值**，只能认一份 —— 认 `assistant/message`。
 *
 * 口径（拿 DSH 自己的投影缓存 `storages/session_projcache/sessions/<id>.json`
 * 逐会话对过账，15 个会话全部逐字节相等）：
 *
 *   uncachedInputTokens === Σ usage.inputTokens
 *
 * 也就是说 `inputTokens` 是**不含缓存读**的纯新增输入，跟 MiMo 一样反着来：
 *
 *   输入 = inputTokens + cacheReadTokens + cacheWriteTokens
 *   缓存命中 = cacheReadTokens
 *   输出 = outputTokens
 *
 * 没有思考 token：pi-ai 把 reasoning 折进 output 了，界面按 hasReasoning('dsh') 收起。
 *
 * 另外两条已知边界：
 *   - 子代理会话（`delegationDepth > 0`）是独立目录，算真实消耗但不并进父会话
 *     （与 ZCode 的 subagent_child 同样处理，不像 Kimi 那样合并）。
 *   - 会话日志是追加写的，正在跑的那个会话可能还没把最后一步 flush 下来，
 *     所以「今日」会滞后几十秒。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* ------------------------------------------------------------ zstd 解码 */

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解一个「多帧拼接」的 zstd 缓冲。
 *
 * Node 的 zstdDecompressSync / 流式解压都只吃第一帧，而 DSH 是**每次追加写一帧**，
 * 本机最大的会话文件有 9411 帧。所以这里按魔数切帧、逐帧解：
 * 魔数可能碰巧出现在压缩数据里（切早了会解压失败），失败就把切片往后延一帧再试；
 * 尾部若是写到一半的半帧，解不出来就停在上一帧，不把整个会话丢掉。
 */
export function decodeZstdFrames(buf: Buffer): string {
  if (typeof zstdDecompressSync !== 'function') return ''

  const parts: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    let next = buf.indexOf(FRAME_MAGIC, offset + 4)
    let done = false
    // 上限 64 次：真的连撞 64 个假魔数时放弃这一帧，交给外层告警
    for (let tries = 0; tries < 64; tries += 1) {
      const end = next === -1 ? buf.length : next
      try {
        parts.push(zstdDecompressSync(buf.subarray(offset, end)))
        offset = end
        done = true
        break
      } catch {
        if (next === -1) break
        next = buf.indexOf(FRAME_MAGIC, next + 4)
      }
    }
    // 尾部半帧：停在上一帧边界，已解出来的内容照常返回
    if (!done) break
  }
  return Buffer.concat(parts).toString('utf8')
}

/* -------------------------------------------------------------- 行形态 */

export interface DshCallRow {
  sessionId: string
  model: string
  timestamp: number
  /** 完整输入 = 非缓存输入 + 缓存读 + 缓存写 */
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface DshSessionParse {
  sessionId: string
  cwd: string
  title: string
  createdAt: number
  delegationDepth: number
  calls: DshCallRow[]
  /** 最后一次请求发出去的完整 prompt */
  contextUsed: number
  /** 最后一次请求所用模型的窗口；拿不到为 0 */
  contextSize: number
}

interface DshCacheEntry {
  mtimeMs: number
  size: number
  parsed: DshSessionParse | null
}

export type DshParseCache = Map<string, DshCacheEntry>

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/* -------------------------------------------------------------- 解析 */

/** `session.jsonl.zstd` 是最早的世代（记 0），`session.v4.jsonl.zstd` 记 4 */
export function sessionLogVersion(name: string): number {
  const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name)
  if (!match) return -1
  return match[1] ? Number(match[1]) : 0
}

/**
 * 把一个会话日志摊成调用列表。
 *
 * 只用 `assistant/message` 里的用量：早期格式还会把同一次用量另发一遍
 * `assistant/chunk`，两份同值，一起算就是双倍（本机对账时正是这么发现的）。
 * 万一遇到只有 chunk 没有 message 的老格式，才退回用 chunk。
 */
export function parseDshLog(text: string, sessionId: string): DshSessionParse {
  let id = sessionId
  let cwd = ''
  let title = ''
  let createdAt = 0
  let delegationDepth = 0
  let model = ''
  const windows = new Map<string, number>()
  const messageCalls: DshCallRow[] = []
  const chunkCalls: DshCallRow[] = []

  for (const line of text.split('\n')) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // 追加写留下的半行：跳过，不影响已经解出来的事件
      continue
    }
    if (!raw || typeof raw !== 'object') continue

    const event = raw as Record<string, any>
    const data = (event.data ?? {}) as Record<string, any>

    switch (event.type) {
      case 'session':
        id = str(event.id) || id
        cwd = str(event.cwd)
        createdAt = num(event.createdAt)
        delegationDepth = num(event.delegationDepth)
        break

      case 'session/title':
        title = str(data.title) || title
        break

      // 三种事件都可能带模型：请求头（首次 / 变更时）、模型选择、请求上下文
      case 'request/header': {
        const config = data.header?.config
        if (config) model = str(config.model) || model
        break
      }
      case 'model/selection':
      case 'request/context': {
        if (str(data.model)) model = str(data.model)
        const window = num(data.contextWindow)
        if (model && window > 0) windows.set(model, window)
        break
      }

      case 'assistant/message': {
        const call = usageOf(data.usage, event.time, id, model)
        if (call) messageCalls.push(call)
        break
      }

      case 'assistant/chunk': {
        if (data.chunk?.type !== 'usage') break
        const call = usageOf(data.chunk.usage, event.time, id, model)
        if (call) chunkCalls.push(call)
        break
      }

      default:
        break
    }
  }

  const calls = messageCalls.length ? messageCalls : chunkCalls
  const last = calls[calls.length - 1]
  return {
    sessionId: id,
    cwd,
    title,
    createdAt,
    delegationDepth,
    calls,
    contextUsed: last?.inputTokens ?? 0,
    contextSize: last ? (windows.get(last.model) ?? 0) : 0
  }
}

/** 把一次请求的 usage 翻成本工具的口径；没有 token 的（比如中断的空步）返回 null */
function usageOf(
  usage: unknown,
  time: unknown,
  sessionId: string,
  model: string
): DshCallRow | null {
  if (!usage || typeof usage !== 'object') return null
  const row = usage as Record<string, unknown>

  // DSH 的 inputTokens 是非缓存输入，缓存读/写得加回来才是完整 prompt
  const cachedTokens = num(row.cacheReadTokens)
  const inputTokens = num(row.inputTokens) + cachedTokens + num(row.cacheWriteTokens)
  const outputTokens = num(row.outputTokens)
  if (inputTokens <= 0 && outputTokens <= 0) return null

  return {
    sessionId,
    model: model || '未知模型',
    timestamp: num(time),
    inputTokens,
    outputTokens,
    cachedTokens
  }
}

/* -------------------------------------------------------------- 目录扫描 */

function statOf(file: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(file)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

/** 会话日志只追加，靠 mtime + size 判断要不要重解；命中就直接复用整段解析结果 */
export function readDshSessionLog(file: string, sessionId: string, cache?: DshParseCache): DshSessionParse | null {
  const stat = statOf(file)
  if (!stat) return null

  const cached = cache?.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.parsed

  let text: string
  try {
    text = decodeZstdFrames(readFileSync(file))
  } catch {
    return null
  }
  if (!text) return null

  const parsed = parseDshLog(text, sessionId)
  cache?.set(file, { ...stat, parsed })
  return parsed
}

interface DshScan {
  sessions: DshSessionParse[]
  files: number
}

function scanDshSessions(dshDir: string, cache?: DshParseCache): DshScan {
  const out: DshSessionParse[] = []
  const root = join(dshDir, 'sessions')
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return { sessions: out, files: 0 }
  }

  let files = 0
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let dirs
    try {
      dirs = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const sessionPath = join(workspacePath, dir.name)

      let names
      try {
        names = readdirSync(sessionPath)
      } catch {
        continue
      }

      // 只认版本号最高的那一代，见文件头注释
      let best = ''
      let bestVersion = -1
      for (const name of names) {
        const version = sessionLogVersion(name)
        if (version > bestVersion) {
          bestVersion = version
          best = name
        }
      }
      if (!best) continue

      files += 1
      const parsed = readDshSessionLog(join(sessionPath, best), dir.name, cache)
      // 一个调用都没有的会话（只开过没说话）不进列表，免得排行榜全是空行
      if (parsed?.calls.length) out.push(parsed)
    }
  }

  return { sessions: out, files }
}

/** 归档会话 id —— 只用来把归档会话排除出「当前活跃会话」的评选 */
function readArchivedIds(dshDir: string): Set<string> {
  const ids = new Set<string>()
  try {
    const raw = JSON.parse(readFileSync(join(dshDir, 'storages', 'workspace.json'), 'utf8')) as Record<string, any>
    const list = raw?.global?.archivedSessionIds
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id)
  } catch {
    /* 文件缺失或改版都不影响用量统计，归档标记留空即可 */
  }
  return ids
}

/* -------------------------------------------------------------- 聚合 */

export interface DshCollectOptions {
  dshDir: string
  cache?: DshParseCache
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 扫描 ~/.dsh/sessions 并摊成一张 Snapshot。
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot。
 */
export function collectDshSnapshot(options: DshCollectOptions): Snapshot {
  const { dshDir, cache } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const scan = scanDshSessions(dshDir, cache)
  if (!scan.files) {
    warnings.push(`未找到 DSH 会话日志（${join(dshDir, 'sessions')}），用量将显示为 0`)
  } else if (!scan.sessions.length && warnings.length === 0) {
    warnings.push('DSH 会话日志里没有读到任何模型调用，用量将显示为 0')
  }

  const archived = readArchivedIds(dshDir)

  const sessions: SourceSession[] = scan.sessions.map((session) => {
    const calls: CallRecord[] = session.calls.map((row) => ({
      // DSH 没有要拿 traceId 对账的东西
      traceId: '',
      sessionId: session.sessionId,
      // 按会话的工作目录分组（会话日志里的 cwd 字段，不用解目录名的转义）
      projectDir: session.cwd || session.sessionId,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      // pi-ai 把 reasoning 折进 output，这一项恒为 0，界面按 hasReasoning('dsh') 收起
      reasoningTokens: 0
    }))

    const last = calls[calls.length - 1]
    return {
      sessionId: session.sessionId,
      projectDir: session.cwd || session.sessionId,
      cwd: session.cwd,
      title: session.title,
      contextUsed: session.contextUsed,
      contextSize: session.contextSize,
      lastActivity: Math.max(last?.timestamp ?? 0, session.createdAt),
      archived: archived.has(session.sessionId),
      calls
    }
  })

  return buildSnapshot(sessions, {
    kind: 'dsh',
    dir: dshDir,
    files: scan.files,
    dbRows: 0,
    now,
    warnings
  })
}
