/**
 * ZCode 用量采集 —— 所有本地源里最省事的一份。
 *
 * ZCode 把每次模型请求的 token 记在一张专门的表里，不用像 WorkBuddy 那样拿
 * traceId 去对账，也不用像 Kimi Code 那样逐行扫 JSONL：
 *
 *   ~/.zcode/cli/db/db.sqlite
 *     model_usage   一次模型请求一行：input / output / reasoning / cache_read ...
 *     session       会话元数据：标题、工作目录、项目、时间、是否归档
 *
 * 口径（实测与 WorkBuddy / Kimi Code 一致）：
 *   input_tokens 是**含缓存读**的完整输入 —— total = input + output，
 *   且实测 input(243577) 远大于 cache_read(243072)，不可能是「非缓存部分」；
 *   缓存命中 = cache_read_input_tokens；思考 token 单列，所以界面上
 *   「· 思考」那一行照旧显示（Kimi Code 没有这一项）。
 *
 * ZCode 没有积分也没有额度：message.cost 恒为 0，coding-plan-cache.json 里
 * 几个内置套餐全是 coding_plan_not_entitled（本机走自带 provider）。所以按
 * 「无积分源」渲染，只报 token。
 *
 * 上下文上限按「模型 id → limit.context」查两张表（匹配对齐到会话最后一次
 * 请求用的那个模型，与 Kimi / MiMo 同口径；键统一小写 —— db 里的 model_id
 * 是 GLM-5.3-Flash，models.dev 那边写作 glm-5.3-flash）：
 *
 *   1) ~/.zcode/v2/config.json 的 provider.<id>.models.<模型>.limit.context，
 *      本地配置过的 provider（builtin:bigmodel-* 等）都在这。那个文件里存着
 *      明文 apiKey，所以这里解析后只挑 limit.context 这一个数字，其余字段
 *      （含密钥）不看、不落盘、不打日志 —— 与 Kimi 读 config.toml 的分寸一致；
 *   2) models.dev 的公共模型目录，兜底远程 provider（opencode-go 系）——
 *      它们的模型目录不落本地，config.json 里没有。目录由 main/modelsdev.ts
 *      每天在后台拉一次，提炼成紧凑的缓存文件，本模块只读这份提炼结果。
 * 两边都查不到的模型上限留 0，界面在 size=0 时会自动退化成不带百分比的写法。
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
  model: string
  timestamp: number
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
 * db.sqlite 带 -wal / -shm，且可能正被运行中的 ZCode 持有 —— 与 workbuddy.db
 * 同一套处理：先试只读直开（最快，也能读到 WAL 里的最新数据），
 * 失败就把三件套一起复制到临时目录再读。
 */
function readDatabase(dbPath: string): DatabaseRead {
  const attempt = (path: string): DatabaseRead | null => {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })

      const usage = (db
        .prepare(
          `SELECT session_id, model_id, started_at,
                  input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
             FROM model_usage
            WHERE started_at IS NOT NULL`
        )
        .all() as Record<string, unknown>[])
        .map((row) => ({
          sessionId: String(row.session_id ?? ''),
          model: String(row.model_id ?? '') || '未知模型',
          timestamp: num(row.started_at),
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens),
          cachedTokens: num(row.cache_read_input_tokens),
          reasoningTokens: num(row.reasoning_tokens)
        }))
        .filter((row) => row.inputTokens > 0 || row.outputTokens > 0)

      const sessions = (db
        .prepare('SELECT id, title, directory, project_id, time_updated, time_archived FROM session')
        .all() as Record<string, unknown>[])
        .map((row) => ({
          id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          cwd: String(row.directory ?? ''),
          projectId: String(row.project_id ?? ''),
          updatedAt: num(row.time_updated),
          archived: num(row.time_archived) > 0
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

  const dir = mkdtempSync(join(tmpdir(), 'wbtm-zcode-db-'))
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

/* ---------------------------------------------------- 模型上下文窗口 */

/**
 * 遍历 <provider>.models.<模型>.limit.context 这一层结构，提炼「模型 id →
 * 上下文窗口」。config.json 与 models.dev 的 api.json 用的是同一套形状，
 * 区别只在最外层：前者包着一层 provider 键，后者本身就是 provider 映射。
 * 同一个模型 id 在多个 provider 段重复出现时取先到的 —— 实测同一模型
 * 各段的 limit 一致，先到先得足够稳定。
 */
function walkContextSizes(providers: unknown): Map<string, number> {
  const sizes = new Map<string, number>()
  if (!providers || typeof providers !== 'object') return sizes
  for (const entry of Object.values(providers as Record<string, unknown>)) {
    const models = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['models'] : null
    if (!models || typeof models !== 'object') continue
    for (const [model, info] of Object.entries(models as Record<string, unknown>)) {
      const limit = info && typeof info === 'object' ? (info as Record<string, unknown>)['limit'] : null
      const context = limit && typeof limit === 'object' ? (limit as Record<string, unknown>)['context'] : null
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
        const key = model.toLowerCase()
        if (!sizes.has(key)) sizes.set(key, context)
      }
    }
  }
  return sizes
}

/**
 * 从 ~/.zcode/v2/config.json 提取每个模型的上下文窗口。
 *
 * 解析后只取 limit.context 这一个数字 —— 文件里的明文 apiKey 与其余配置
 * 一律不读出函数、不落盘、不打日志。
 */
export function parseConfigContextSizes(text: string): Map<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new Map()
  }
  return walkContextSizes((parsed as Record<string, unknown> | null)?.['provider'])
}

/** 从 models.dev 的 api.json 提取模型上下文窗口（provider 映射就是根对象） */
export function parseModelsDevContextSizes(text: string): Map<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new Map()
  }
  return walkContextSizes(parsed)
}

interface CatalogCache {
  mtimeMs: number
  sizes: Map<string, number>
}

let catalogCache: CatalogCache | null = null

/**
 * 读 models.dev 的提炼缓存（main 每天后台重写一次）。文件几十 KB，按 mtime
 * 缓存解析结果；写坏的那一次（parse 失败）不进缓存，下个轮询周期会自然重试。
 */
function readModelsDevCache(file: string): Map<string, number> {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return new Map()
  }
  if (catalogCache && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.sizes

  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { sizes?: Record<string, unknown> }
    const sizes = new Map<string, number>()
    for (const [model, context] of Object.entries(raw.sizes ?? {})) {
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
        sizes.set(model.toLowerCase(), context)
      }
    }
    catalogCache = { mtimeMs: stat.mtimeMs, sizes }
    return sizes
  } catch {
    return new Map()
  }
}

/** 本地 config 优先，models.dev 只补缺口 */
function contextSizes(zcodeDir: string, modelsDevCache?: string): Map<string, number> {
  const sizes = parseConfigContextSizes(readText(join(zcodeDir, 'v2', 'config.json')))
  if (modelsDevCache) {
    for (const [model, context] of readModelsDevCache(modelsDevCache)) {
      if (!sizes.has(model)) sizes.set(model, context)
    }
  }
  return sizes
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/* -------------------------------------------------------------- 聚合 */

export interface ZcodeCollectOptions {
  zcodeDir: string
  /**
   * models.dev 提炼缓存的路径（main 放在 userData 下）。不传就只认本地
   * config.json —— 远程 provider 的模型窗口会退化成「只报已用」。
   */
  modelsDevCache?: string
  /** 用于判定「今天」的时间戳，默认取当前时间；测试时可注入固定值 */
  now?: number
}

/**
 * 读 ~/.zcode/cli/db/db.sqlite 并摊成一张 Snapshot。
 *
 * 日 / 模型 / 项目 / 活跃会话这些口径交给共用的 aggregate.buildSnapshot，
 * 这里只负责把表结构翻译成 SourceSession。没有文件级解析缓存 ——
 * 库很小（本机 168 行用量 + 19 行会话），20 秒一次全量读的代价可以忽略。
 */
export function collectZcodeSnapshot(options: ZcodeCollectOptions): Snapshot {
  const { zcodeDir } = options
  const now = options.now ?? Date.now()
  const warnings: string[] = []

  const dbPath = join(zcodeDir, 'cli', 'db', 'db.sqlite')
  const db = readDatabase(dbPath)
  if (!db.usage.length && !db.sessions.length) {
    warnings.push(`未能读取 ZCode 用量库（${dbPath}），用量将显示为 0`)
  }

  const sizes = contextSizes(zcodeDir, options.modelsDevCache)

  const meta = new Map(db.sessions.map((row) => [row.id, row]))

  // 一个会话的上下文水位 = 它最后一次请求的输入 token（那正是发出去的完整上下文）
  const lastRequest = new Map<string, UsageRow>()
  const callsBySession = new Map<string, CallRecord[]>()
  for (const row of db.usage) {
    const previous = lastRequest.get(row.sessionId)
    if (!previous || row.timestamp >= previous.timestamp) lastRequest.set(row.sessionId, row)

    const call: CallRecord = {
      // ZCode 的 trace_id 是给自家链路追踪用的；这里没有积分要对账，不需要带上
      traceId: '',
      conversationRequestId: '',
      sessionId: row.sessionId,
      projectDir: meta.get(row.sessionId)?.projectId || row.sessionId,
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
    // 上下文窗口按「最后用的模型」算：会话中途换过模型时，水位要对着当前这个
    const windowSize = last ? sizes.get(last.model.toLowerCase()) : undefined
    sessions.push({
      sessionId,
      projectDir: info?.projectId || sessionId,
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
    kind: 'zcode',
    dir: zcodeDir,
    files: 0,
    dbRows: db.usage.length,
    now,
    warnings
  })
}
