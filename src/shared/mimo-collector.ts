/**
 * Xiaomi MiMo 桌面端（mimocode 引擎）用量采集。
 *
 * 数据根不是 ~/.mimocode（那只是插件工作区），而是引擎自己的库：
 *
 *   ~/.local/share/mimocode/mimocode.db
 *     message   每条助手消息的 data JSON 里带 tokens / cost
 *     session   标题、目录、项目、创建 / 更新 / 归档时间
 *   ~/.cache/mimocode/models.json
 *     引擎的模型目录（223 个 provider），含每个模型的 limit.context
 *
 * 口径 —— 这一家和另外三个源**反着来**，映射时必须转一道：
 *
 *   total = input + output + reasoning + cache.read + cache.write
 *
 * 也就是说 `input` 是**不含缓存读**的纯新增输入（本机 84 条消息残差恒为 0），
 * 而 WorkBuddy / Kimi Code / ZCode 的 input 都含缓存。所以：
 *
 *   输入 = input + cache.read + cache.write
 *   缓存命中 = cache.read
 *   思考 = reasoning（单列，界面上的「· 思考」照旧显示）
 *
 * 取 message 级而不是 part 级：part 表里 step-finish 那份 tokens 与 message
 * **完全同值**（是副本），而 message 级更全（本机 84 条 vs 72 条）。
 *
 * 不读 cost：那是金额不是积分，货币单位也随 provider 变，界面上没有它的位置。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
 * mimocode.db 带 -wal / -shm，且可能正被运行中的 MiMo 持有 —— 与 workbuddy.db
 * 同一套处理：先试只读直开（最快，也能读到 WAL 里的最新数据），
 * 失败就把三件套一起复制到临时目录再读。
 *
 * tokens 用 json_extract 直接在 SQL 里取出来，不把整个 data JSON 拉进 JS ——
 * 消息表会一直长，全量 JSON.parse 是白白烧 CPU。
 */
function readDatabase(dbPath: string): DatabaseRead {
  const attempt = (path: string): DatabaseRead | null => {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })

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

  const dir = mkdtempSync(join(tmpdir(), 'wbtm-mimo-db-'))
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

/* -------------------------------------------------------- 模型上下文窗口 */

interface ModelCatalog {
  mtimeMs: number
  sizes: Map<string, number>
}

let catalogCache: ModelCatalog | null = null

/**
 * 从引擎的模型目录里取上下文窗口，键是 `provider/model`。
 *
 * 文件 4.9 MB、223 个 provider，解析一次几十毫秒 —— 按 mtime 缓存，
 * 只有引擎自己刷新了目录才重读。文件缺失或模型不在里面时窗口留 0，
 * 界面会退化成「只报已用量」。
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

export interface MimoCollectOptions {
  /** 引擎数据目录，默认 ~/.local/share/mimocode */
  mimoDir: string
  /** 引擎缓存目录（models.json 在里面），默认 ~/.cache/mimocode */
  cacheDir: string
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 读 mimocode.db 并摊成一张 Snapshot。
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot。
 */
export function collectMimoSnapshot(options: MimoCollectOptions): Snapshot {
  const { mimoDir, cacheDir } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const dbPath = join(mimoDir, 'mimocode.db')
  const db = readDatabase(dbPath)
  if (!db.usage.length && !db.sessions.length) {
    warnings.push(`未能读取 MiMo 用量库（${dbPath}），用量将显示为 0`)
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
      // MiMo 没有要拿 traceId 对账的东西
      traceId: '',
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
      // 按会话所在目录分组比按 project_id 实在：'global' 这一个 id 底下
      // 混着好几个不同目录的会话
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
    kind: 'mimo',
    dir: mimoDir,
    files: 0,
    dbRows: db.usage.length,
    now,
    warnings
  })
}
