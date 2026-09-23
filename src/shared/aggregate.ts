/**
 * 采集结果的公共聚合 —— Kimi Code 与 ZCode 共用。
 *
 * 刻意**不包含 WorkBuddy**：那条链路要拿 traceId 去数据库对积分，口径和这两个
 * 「只有 token」的源差得远，混在一起改就有碰坏它的风险，而那份统计是这个工具
 * 存在的理由。WorkBuddy 的聚合仍然留在 collector.ts 里，一行没动。
 *
 * 各采集器只负责把自家数据整理成 SourceSession[]（会话 + 该会话的全部调用），
 * 剩下的「日 / 模型 / 项目 / 会话排行 / 活跃会话」这套口径统一在这里算。
 */
import { addCall, emptyBundle, localDate, mostFrequentModel } from './collector'
import type {
  ActiveContext,
  CallRecord,
  DayStat,
  ModelStat,
  ProjectStat,
  SessionStat,
  Snapshot,
  SourceKind,
  TokenBundle,
  Totals
} from './types'

/** 一个会话在聚合器眼里的样子 */
export interface SourceSession {
  sessionId: string
  /** 项目维度的聚合键（Kimi 用工作区目录名，ZCode 用 project_id） */
  projectDir: string
  cwd: string
  title: string
  /** 上下文已用 token；拿不到就填 0 */
  contextUsed: number
  /** 上下文上限；拿不到就填 0，界面会退化成「只报已用」 */
  contextSize: number
  lastActivity: number
  /** 归档会话不参与「当前活跃会话」的评选 */
  archived: boolean
  calls: CallRecord[]
}

export interface AggregateOptions {
  kind: SourceKind
  dir: string
  /** 参与统计的数据文件数（没有文件概念的数据源填 0） */
  files: number
  /** 数据库行数 */
  dbRows: number
  now: number
  warnings: string[]
}

/**
 * 把会话列表摊成一张 Snapshot。
 *
 * 这两个源都没有积分，所以积分相关的字段一律留 0 —— 界面靠 snapshot.kind
 * 决定这些位置显不显示，显示成 0 分比不显示更糟。
 */
export function buildSnapshot(sessions: SourceSession[], options: AggregateOptions): Snapshot {
  const { now } = options
  const todayKey = localDate(now)

  const sessionStats: SessionStat[] = []
  const dayMap = new Map<string, DayStat>()
  const modelMap = new Map<string, ModelStat>()
  const projectMap = new Map<string, ProjectStat>()

  const totals: Totals = {
    ...emptyBundle(),
    credits: 0,
    attributedCredits: 0,
    unattributedCredits: 0,
    sessions: 0,
    traces: 0,
    matchedTraces: 0,
    dbTraces: 0
  }

  const todayBundle: TokenBundle & { credits: number } = { ...emptyBundle(), credits: 0 }

  // 活跃会话：取未归档里最近有动静的那个
  let activeSource: SessionStat | null = null
  let activeAt = -1

  for (const session of sessions) {
    const bundle = emptyBundle()
    let lastActivity = session.lastActivity

    for (const call of session.calls) {
      addCall(bundle, call)
      if (call.timestamp > lastActivity) lastActivity = call.timestamp

      const dayKey = localDate(call.timestamp)
      let day = dayMap.get(dayKey)
      if (!day) {
        day = { ...emptyBundle(), date: dayKey, credits: 0 }
        dayMap.set(dayKey, day)
      }
      addCall(day, call)
      if (dayKey === todayKey) addCall(todayBundle, call)

      let model = modelMap.get(call.model)
      if (!model) {
        model = { ...emptyBundle(), model: call.model, credits: 0, sessions: 0 }
        modelMap.set(call.model, model)
      }
      addCall(model, call)
    }

    totals.calls += bundle.calls
    totals.inputTokens += bundle.inputTokens
    totals.outputTokens += bundle.outputTokens
    totals.cachedTokens += bundle.cachedTokens
    totals.reasoningTokens += bundle.reasoningTokens
    totals.sessions += 1

    let project = projectMap.get(session.projectDir)
    if (!project) {
      project = { ...emptyBundle(), projectDir: session.projectDir, cwd: session.cwd, sessions: 0 }
      projectMap.set(session.projectDir, project)
    }
    project.calls += bundle.calls
    project.inputTokens += bundle.inputTokens
    project.outputTokens += bundle.outputTokens
    project.cachedTokens += bundle.cachedTokens
    project.reasoningTokens += bundle.reasoningTokens
    project.sessions += 1

    const stat: SessionStat = {
      sessionId: session.sessionId,
      title: session.title || '(未命名会话)',
      cwd: session.cwd,
      projectDir: session.projectDir,
      model: mostFrequentModel(session.calls),
      status: '',
      credits: 0,
      totalTraces: 0,
      matchedTraces: 0,
      contextUsed: session.contextUsed,
      contextSize: session.contextSize,
      lastActivity,
      ...bundle
    }
    sessionStats.push(stat)

    if (!session.archived && lastActivity > activeAt) {
      activeAt = lastActivity
      activeSource = stat
    }
  }

  for (const [modelName, stat] of modelMap) {
    let count = 0
    for (const session of sessions) {
      if (session.calls.some((call) => call.model === modelName)) count += 1
    }
    stat.sessions = count
  }

  const active: ActiveContext | null = activeSource
    ? {
        sessionId: activeSource.sessionId,
        title: activeSource.title,
        cwd: activeSource.cwd,
        used: activeSource.contextUsed,
        size: activeSource.contextSize,
        updatedAt: activeSource.lastActivity
      }
    : null

  const byTokens = (a: { inputTokens: number; outputTokens: number }, b: { inputTokens: number; outputTokens: number }): number =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)

  return {
    kind: options.kind,
    generatedAt: now,
    totals,
    today: todayBundle,
    sessions: sessionStats.sort((a, b) => b.lastActivity - a.lastActivity),
    days: [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
    models: [...modelMap.values()].sort(byTokens),
    projects: [...projectMap.values()].sort(byTokens),
    active,
    source: {
      dir: options.dir,
      files: options.files,
      dbRows: options.dbRows
    },
    warnings: options.warnings
  }
}
