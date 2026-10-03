/**
 * OpenCode 桌面端（opencode 引擎）用量采集。
 *
 * 桌面端自己不留用量账 —— 它启动 engine sidecar，账记在引擎的数据目录里，
 * 而且与 opencode CLI **共用同一个库**（session.version 只是引擎版本号，
 * 两条链路的会话都在里面，拆不开；面板上就按「OpenCode」一家算）：
 *
 *   ~/.local/share/opencode/opencode.db
 *     message   每条助手消息的 data JSON 里带 tokens / modelID / providerID
 *     session   标题、目录、创建 / 更新 / 归档时间
 *   ~/.cache/opencode/models.json
 *     引擎的模型目录，含每个模型的 limit.context
 *
 * 口径与 Xiaomi MiMo（mimocode 引擎）完全同类 —— 是同源的表结构，
 * 映射时必须转一道：
 *
 *   total = input + output + reasoning + cache.read + cache.write
 *
 * 也就是说 `input` 是**不含缓存读**的纯新增输入，要加回来才是完整输入：
 *
 *   输入 = input + cache.read + cache.write
 *   缓存命中 = cache.read
 *   思考 = reasoning（单列，界面上的「· 思考」照旧显示）
 *
 * 取 message 级而不是 part 级：part 里 step-finish 那份 tokens 与 message
 * 完全同值（是副本），而 message 级更全。
 *
 * 这个库比其它源大得多（本机 732 MB，其中 event 表就占 569 MB），所以两处
 * 刻意不跟 MiMo / ZCode 走：
 *   1. 不套「复制三件套」的读库兜底 —— 为读两千行去复制 700 MB 不划算。
 *      SQLite 的只读连接本来就允许别的进程在写（实测另开进程持写事务时照样
 *      读得到），所以直开失败只报 warning；
 *   2. 只碰 message / session 两张表，event / part 一概不看。
 *
 * 不读 cost：那是金额不是积分，货币单位也随 provider 变，界面上没有它的位置
 * （本机全是免费模型，它恒为 0）。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildSnapshot, type SourceSession } from './aggregate'
import type { CallRecord, Snapshot } from './types'

/* -------------------------------------------------------------- 行形态 */

interface UsageRow {
  sessionId: string
  timestamp: number
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

interface SessionRow {
  id: string
  title: string
  cwd: string
  projectId: string
  updatedAt: number
  archived: boolean
}

interface DatabaseRead {
  usage: UsageRow[]
  sessions: SessionRow[]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/* -------------------------------------------------------------- 读库 */

/**
 * 只读直开 opencode.db。带 -wal / -shm 也没关系 —— 只读连接能读到 WAL 里
 * 的最新数据，桌面端正在运行时也读得到（见文件头的说明，这里不复制兜底）。
 *
 * tokens 用 json_extract 直接在 SQL 里取，不把整个 data JSON 拉进 JS ——
 * message 表有 100 MB 上下，其中还夹着几十 MB 的 user 附件消息，
 * 全量 JSON.parse 是白白烧 CPU。
 */
function readDatabase(dbPath: string): DatabaseRead {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })

    const usage = (db
      .prepare(
        `SELECT m.session_id AS sessionId,
                m.time_created AS timestamp,
                json_extract(m.data, '$.modelID') AS model,
                json_extract(m.data, '$.providerID') AS provider,
                json_extract(m.data, '$.tokens.input') AS input,
                json_extract(m.data, '$.tokens.output') AS output,
                json_extract(m.data, '$.tokens.reasoning') AS reasoning,
                json_extract(m.data, '$.tokens.cache.read') AS cacheRead,
                json_extract(m.data, '$.tokens.cache.write') AS cacheWrite
           FROM message m
          WHERE json_valid(m.data) AND json_extract(m.data, '$.tokens') IS NOT NULL`
      )
      .all() as Record<string, unknown>[])
      .map((row) => {
        const cachedTokens = num(row.cacheRead) + num(row.cacheWrite)
        return {
          sessionId: String(row.sessionId ?? ''),
          timestamp: num(row.timestamp),
          model: String(row.model ?? '') || '未知模型',
          provider: String(row.provider ?? ''),
          // input 不含缓存，要加回来才是完整的输入
          inputTokens: num(row.input) + cachedTokens,
          outputTokens: num(row.output),
          cachedTokens: num(row.cacheRead),
          reasoningTokens: num(row.reasoning)
        }
      })
      .filter((row) => row.inputTokens > 0 || row.outputTokens > 0)

    const sessions = (db
      .prepare(
        `SELECT id,
                title,
                directory,
                project_id AS projectId,
                time_updated AS updatedAt,
                time_archived AS archivedAt
           FROM session`
      )
      .all() as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id ?? ''),
        title: String(row.title ?? ''),
        cwd: String(row.directory ?? ''),
        projectId: String(row.projectId ?? ''),
        updatedAt: num(row.updatedAt),
        archived: num(row.archivedAt) > 0
      }))

    return { usage, sessions }
  } catch {
    return { usage: [], sessions: [] }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------- 模型上下文窗口 */

interface ModelCatalog {
  mtimeMs: number
  sizes: Map<string, number>
}

let catalogCache: ModelCatalog | null = null

/**
 * 从引擎的模型目录里取上下文窗口，键是 `provider/model`。
 *
 * 桌面端与 CLI 一跑就会刷新这份目录（本机 5 MB 上下），解析一次几十毫秒 ——
 * 按 mtime 缓存，只有引擎自己更新了目录才重读。文件缺失或模型不在里面时
 * 窗口留 0，界面会退化成「只报已用量」。
 */
function readContextSizes(file: string): Map<string, number> {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return new Map()
  }
  if (catalogCache && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.sizes

  const sizes = new Map<string, number>()
  try {
    const catalog = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    for (const [provider, entry] of Object.entries(catalog)) {
      const models = entry && typeof entry === 'object' ? entry.models : null
      if (!models || typeof models !== 'object') continue
      for (const [model, info] of Object.entries(models as Record<string, any>)) {
        const context = num(info?.limit?.context)
        if (context > 0) sizes.set(`${provider}/${model}`, context)
      }
    }
  } catch {
    return new Map()
  }

  catalogCache = { mtimeMs: stat.mtimeMs, sizes }
  return sizes
}

/* -------------------------------------------------------------- 聚合 */

export interface OpencodeCollectOptions {
  /** 引擎数据目录，默认 ~/.local/share/opencode */
  opencodeDir: string
  /** 引擎缓存目录（models.json 在里面），默认 ~/.cache/opencode */
  cacheDir: string
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 读 opencode.db 并摊成一张 Snapshot。
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot。
 */
export function collectOpencodeSnapshot(options: OpencodeCollectOptions): Snapshot {
  const { opencodeDir, cacheDir } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const dbPath = join(opencodeDir, 'opencode.db')
  const db = readDatabase(dbPath)
  if (!db.usage.length && !db.sessions.length) {
    warnings.push(`未能读取 OpenCode 用量库（${dbPath}），用量将显示为 0`)
  }

  const meta = new Map(db.sessions.map((row) => [row.id, row]))
  const sizes = readContextSizes(join(cacheDir, 'models.json'))

  // 一个会话的上下文水位 = 它最后一次请求的 prompt（input + 缓存读/写），
  // 同时记住那次用的模型 —— 窗口要对着当前这个模型算
  const lastRequest = new Map<string, UsageRow>()
  const callsBySession = new Map<string, CallRecord[]>()
  for (const row of db.usage) {
    const previous = lastRequest.get(row.sessionId)
    if (!previous || row.timestamp >= previous.timestamp) lastRequest.set(row.sessionId, row)

    const call: CallRecord = {
      // 这一边没有要拿 traceId 对账的东西
      traceId: '',
      conversationRequestId: '',
      sessionId: row.sessionId,
      projectDir: meta.get(row.sessionId)?.cwd || row.sessionId,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      reasoningTokens: row.reasoningTokens
    }
    const list = callsBySession.get(row.sessionId)
    if (list) list.push(call)
    else callsBySession.set(row.sessionId, [call])
  }

  const sessions: SourceSession[] = []
  for (const [sessionId, calls] of callsBySession) {
    const info = meta.get(sessionId)
    const last = lastRequest.get(sessionId)
    const windowSize = last ? sizes.get(`${last.provider}/${last.model}`) : undefined
    sessions.push({
      sessionId,
      // 按会话所在目录分组：project_id 里的 'global' 一个 id 底下混着好几个
      // 不同目录的会话（和 MiMo 一个情形）
      projectDir: info?.cwd || info?.projectId || sessionId,
      cwd: info?.cwd ?? '',
      title: info?.title ?? '',
      contextUsed: last?.inputTokens ?? 0,
      contextSize: windowSize ?? 0,
      lastActivity: info?.updatedAt ?? calls[calls.length - 1].timestamp,
      archived: info?.archived ?? false,
      calls
    })
  }

  return buildSnapshot(sessions, {
    kind: 'opencode-desktop',
    dir: opencodeDir,
    files: 0,
    dbRows: db.usage.length,
    now,
    warnings
  })
}
