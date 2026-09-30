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
  /** 水位比例 0..1；拿不到比例（只有 Qoder CN 拿得到）就不填 */
  contextRatio?: number
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
 * 积分按调用逐笔累加（只有 Qoder CN 的 CallRecord 带 credits，其余源视作 0）——
 * Qoder CN 的计费回合就写在会话明细里，没有 WorkBuddy 那种独立的计费表，
 * 所以「计费回合数」直接取调用数、没有未归因一说。
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
    let sessionCredits = 0

    for (const call of session.calls) {
      addCall(bundle, call)
      if (call.timestamp > lastActivity) lastActivity = call.timestamp
      const callCredits = call.credits ?? 0
      sessionCredits += callCredits

      const dayKey = localDate(call.timestamp)
      let day = dayMap.get(dayKey)
      if (!day) {
        day = { ...emptyBundle(), date: dayKey, credits: 0 }
        dayMap.set(dayKey, day)
      }
      addCall(day, call)
      day.credits += callCredits
      if (dayKey === todayKey) {
        addCall(todayBundle, call)
        todayBundle.credits += callCredits
      }

      let model = modelMap.get(call.model)
      if (!model) {
        model = { ...emptyBundle(), model: call.model, credits: 0, sessions: 0 }
        modelMap.set(call.model, model)
      }
      addCall(model, call)
      model.credits += callCredits
    }

    totals.calls += bundle.calls
    totals.inputTokens += bundle.inputTokens
    totals.outputTokens += bundle.outputTokens
    totals.cachedTokens += bundle.cachedTokens
    totals.reasoningTokens += bundle.reasoningTokens
    totals.credits += sessionCredits
    totals.sessions += 1

    let project = projectMap.get(session.projectDir)
    if (!project) {
      project = { ...emptyBundle(), projectDir: session.projectDir, cwd: session.cwd, sessions: 0, credits: 0 }
      projectMap.set(session.projectDir, project)
    }
    project.calls += bundle.calls
    project.inputTokens += bundle.inputTokens
    project.outputTokens += bundle.outputTokens
    project.cachedTokens += bundle.cachedTokens
    project.reasoningTokens += bundle.reasoningTokens
    project.credits += sessionCredits
    project.sessions += 1

    const stat: SessionStat = {
      sessionId: session.sessionId,
      title: session.title || '(未命名会话)',
      cwd: session.cwd,
      projectDir: session.projectDir,
      model: mostFrequentModel(session.calls),
      status: '',
      credits: sessionCredits,
      totalTraces: 0,
      matchedTraces: 0,
      contextUsed: session.contextUsed,
      contextSize: session.contextSize,
      contextRatio: session.contextRatio,
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
        ratio: activeSource.contextRatio,
        updatedAt: activeSource.lastActivity
      }
    : null

  /*
   * 排行权重：token 为主，只有积分的源（Qoder CN）按积分排 —— 一个源要么走
   * token 要么走积分，不会混着比，两边量级差多少都不影响。
   */
  const weight = (item: { inputTokens: number; outputTokens: number; credits: number }): number =>
    item.inputTokens + item.outputTokens + item.credits
  const byWeight = (a: { inputTokens: number; outputTokens: number; credits: number }, b: { inputTokens: number; outputTokens: number; credits: number }): number =>
    weight(b) - weight(a)

  // 有积分账本的源（Qoder CN）每个调用就是一次计费回合 —— 它没有 WorkBuddy
  // 那种独立的计费表，所以没有「未归因」一说，计费回合数直接等于调用数。
  if (totals.credits > 0) {
    totals.traces = totals.calls
    totals.matchedTraces = totals.calls
    totals.dbTraces = totals.calls
  }

  return {
    kind: options.kind,
    generatedAt: now,
    totals,
    today: todayBundle,
    sessions: sessionStats.sort((a, b) => b.lastActivity - a.lastActivity),
    days: [...dayMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
    models: [...modelMap.values()].sort(byWeight),
    projects: [...projectMap.values()].sort(byWeight),
    active,
    source: {
      dir: options.dir,
      files: options.files,
      dbRows: options.dbRows
    },
    warnings: options.warnings
  }
}
