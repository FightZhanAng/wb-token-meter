/**
 * OpenCode 桌面端（opencode 引擎）用量采集。
 *
 * 桌面端自己不留用量账 —— 它启动 engine sidecar，账记在引擎的数据目录里，
 * 而且与 opencode CLI **共用同一个库**（session.version 只是引擎版本号，
 * 两条链路的会话都在里面，拆不开；面板上就按「OpenCode」一家算）：
 *
 *   ~/.local/share/opencode/opencode.db
 *     message / session               1.x 引擎的表
 *     session_message / session_v2    2.x 引擎的表（2.2.5 起只写这两张）
 *   ~/.cache/opencode/models.json
 *     引擎的模型目录，含每个模型的 limit.context
 *
 * **两张用量表都要读，不能只读一张。** 引擎 2.2.5（2026-11-04）把写入整体搬到
 * session_message / session_v2，旧表当场停写 —— 只读 message 的话，升级之后
 * 面板上「今日」永远是 0，历史也停在升级那一刻（本机实测就是这个现象）。
 * 而更早的引擎只写旧表，所以两边都得认：
 *
 *   - 两张表都读，按消息 id 去重（升级时引擎会把旧行回填进新表，双写期两边
 *     同 id 的 tokens 完全同值，不去重就会翻倍）；
 *   - 新表优先：同 id 时用 session_message 那份；
 *   - 两张表都可能不存在（全新安装的库只有新表、很旧的库只有旧表），
 *     所以先查 sqlite_master 再决定读哪张，缺表不算错。
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
 * 这个库比其它源大得多（本机 1.3 GB，其中 event 表就占大头），所以两处
 * 刻意不跟 MiMo / ZCode 走：
 *   1. 不套「复制三件套」的读库兜底 —— 为读两千行去复制 1 GB 不划算。
 *      SQLite 的只读连接本来就允许别的进程在写（实测另开进程持写事务时照样
 *      读得到），所以直开失败只报 warning；
 *   2. 只碰 message / session_message / session / session_v2 四张表，
 *      event / part 一概不看。
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
  /** 消息 id —— 新旧表共用同一个 id 空间，升级回填后要去重 */
  id: string
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

/** SQL 直接吐出来的原始行：字段全是 unknown，换算在 toUsageRow / toSessionRow 里做 */
interface RawUsageRow {
  id?: unknown
  sessionId?: unknown
  timestamp?: unknown
  model?: unknown
  provider?: unknown
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
}

interface RawSessionRow {
  id?: unknown
  title?: unknown
  directory?: unknown
  projectId?: unknown
  updatedAt?: unknown
  archivedAt?: unknown
}

interface DatabaseRead {
  usage: UsageRow[]
  sessions: SessionRow[]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/* -------------------------------------------------------------- 读库 */

/** 库里有没有这张表 —— 新旧引擎的库表结构不一样，缺表是正常情形，不是错误 */
function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name?: unknown } | undefined
  return typeof row?.name === 'string'
}

/**
 * 旧引擎（1.x）的用量行：message.data 里 modelID / providerID 是平铺的。
 * tokens 结构与新表完全同构，映射不必分叉。
 */
function readLegacyUsage(db: DatabaseSync): RawUsageRow[] {
  if (!hasTable(db, 'message')) return []
  return db
    .prepare(
      `SELECT m.id AS id,
              m.session_id AS sessionId,
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
    .all() as unknown as RawUsageRow[]
}

/**
 * 新引擎（2.x）的用量行：model 变成嵌套的 `{id, providerID}`，
 * 用量落在 session_message 表（type 是 assistant / compaction 等，
 * 只要带 tokens 就是一笔真实开销 —— 压缩摘要那次请求同样烧 token）。
 */
function readModernUsage(db: DatabaseSync): RawUsageRow[] {
  if (!hasTable(db, 'session_message')) return []
  return db
    .prepare(
      `SELECT m.id AS id,
              m.session_id AS sessionId,
              m.time_created AS timestamp,
              json_extract(m.data, '$.model.id') AS model,
              json_extract(m.data, '$.model.providerID') AS provider,
              json_extract(m.data, '$.tokens.input') AS input,
              json_extract(m.data, '$.tokens.output') AS output,
              json_extract(m.data, '$.tokens.reasoning') AS reasoning,
              json_extract(m.data, '$.tokens.cache.read') AS cacheRead,
              json_extract(m.data, '$.tokens.cache.write') AS cacheWrite
         FROM session_message m
        WHERE json_valid(m.data) AND json_extract(m.data, '$.tokens') IS NOT NULL`
    )
    .all() as unknown as RawUsageRow[]
}

/** 把一行原始记录摊成 UsageRow；口径换算只在这里做一次 */
function toUsageRow(raw: RawUsageRow): UsageRow {
  const cachedTokens = num(raw.cacheRead) + num(raw.cacheWrite)
  return {
    id: String(raw.id ?? ''),
    sessionId: String(raw.sessionId ?? ''),
    timestamp: num(raw.timestamp),
    model: String(raw.model ?? '') || '未知模型',
    provider: String(raw.provider ?? ''),
    // input 不含缓存，要加回来才是完整的输入
    inputTokens: num(raw.input) + cachedTokens,
    outputTokens: num(raw.output),
    cachedTokens: num(raw.cacheRead),
    reasoningTokens: num(raw.reasoning)
  }
}

function toSessionRow(raw: RawSessionRow): SessionRow {
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    cwd: String(raw.directory ?? ''),
    projectId: String(raw.projectId ?? ''),
    updatedAt: num(raw.updatedAt),
    archived: num(raw.archivedAt) > 0
  }
}

/**
 * 旧引擎（1.x）的会话元数据。
 */
function readLegacySessions(db: DatabaseSync): SessionRow[] {
  if (!hasTable(db, 'session')) return []
  return (
    db
      .prepare(
        `SELECT id,
              title,
              directory,
              project_id AS projectId,
              time_updated AS updatedAt,
              time_archived AS archivedAt
         FROM session`
      )
      .all() as unknown as RawSessionRow[]
  ).map(toSessionRow)
}

/**
 * 新引擎（2.x）的会话元数据。列名与旧表几乎一致，只有标题可能为空
 * （新建会话在用户发第一句话之前没有标题），界面上留空由聚合器兜底。
 */
function readModernSessions(db: DatabaseSync): SessionRow[] {
  if (!hasTable(db, 'session_v2')) return []
  return (
    db
      .prepare(
        `SELECT id,
              title,
              directory,
              project_id AS projectId,
              time_updated AS updatedAt,
              time_archived AS archivedAt
         FROM session_v2`
      )
      .all() as unknown as RawSessionRow[]
  ).map(toSessionRow)
}

/**
 * 只读直开 opencode.db。带 -wal / -shm 也没关系 —— 只读连接能读到 WAL 里
 * 的最新数据，桌面端正在运行时也读得到（见文件头的说明，这里不复制兜底）。
 *
 * tokens 用 json_extract 直接在 SQL 里取，不把整个 data JSON 拉进 JS ——
 * message 表有 100 MB 上下，其中还夹着几十 MB 的 user 附件消息，
 * 全量 JSON.parse 是白白烧 CPU。
 *
 * 新旧表合并：**新表优先，按 id 去重**。升级时引擎会把旧行回填进新表
 * （本机实测 1023 条同 id 行 tokens 逐字段相同），不按 id 去重就会把
 * 同一笔用量算两遍。会话元数据同理 —— 同一个会话 id 在两张表里都有时
 * 取新表那份（旧表在 2.x 里已停写，标题不会再有更新）。
 */
function readDatabase(dbPath: string): DatabaseRead {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })

    const modern = readModernUsage(db).map(toUsageRow)
    const legacy = readLegacyUsage(db).map(toUsageRow)
    const seen = new Set(modern.map((row) => row.id))
    // 只有新表里没有的旧行才补进来；两张表都没有时这里自然是空
    const usage = modern
      .concat(legacy.filter((row) => !seen.has(row.id)))
      .filter((row) => row.inputTokens > 0 || row.outputTokens > 0)

    const modernSessions = readModernSessions(db)
    const legacySessions = readLegacySessions(db)
    const sessionsById = new Map<string, SessionRow>()
    for (const row of legacySessions) sessionsById.set(row.id, row)
    for (const row of modernSessions) sessionsById.set(row.id, row)
    const sessions = [...sessionsById.values()]

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
