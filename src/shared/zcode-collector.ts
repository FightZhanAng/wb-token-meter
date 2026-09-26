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
 * 上下文上限拿不到，本模块**刻意不读 ~/.zcode/v2/config.json**：
 *   1) 模型窗口写在那个文件的 provider.<id>.models.<模型>.limit.context 里，
 *      但本机在用的 opencode-go-chat / deepseek-v4.1-flash 根本不在里面
 *      （远程 provider 的模型目录不落本地）；
 *   2) 那个文件里存着**明文 apiKey**，为了一项可有可无的窗口数值去整读它，
 *      风险和收益不成比例。
 * 于是水位只报「已用多少 token」，界面在 size=0 时会自动退化成不带百分比的写法。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
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

/* -------------------------------------------------------------- 聚合 */

export interface ZcodeCollectOptions {
  zcodeDir: string
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
    sessions.push({
      sessionId,
      projectDir: info?.projectId || sessionId,
      cwd: info?.cwd ?? '',
      title: info?.title ?? '',
      contextUsed: lastRequest.get(sessionId)?.inputTokens ?? 0,
      // 模型窗口不落本地（见文件头注释），所以上限留 0，界面只报已用
      contextSize: 0,
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
