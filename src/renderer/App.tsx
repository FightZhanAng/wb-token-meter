import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { DayStat, Snapshot } from '@shared/types'
import {
  compact,
  credits as formatCredits,
  dayKeyOf,
  formatClock,
  grouped,
  percent,
  projectLabel,
  relativeTime,
  shiftDays,
  startOfToday,
  tokenPerCredit
} from '@shared/format'

/* ------------------------------------------------------------ 小工具 */

function levelOf(ratio: number): 'safe' | 'warn' | 'danger' {
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warn'
  return 'safe'
}

interface BarRow {
  name: string
  value: number
  color: string
  hint?: string
}

function Bars({ rows }: { rows: BarRow[] }): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="bars">
      {rows.map((row) => (
        <div className="bar-row" key={row.name}>
          <div className="bar-name" title={row.name}>
            {row.name}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(row.value / max) * 100}%`, background: row.color }} />
          </div>
          <div className="bar-value">
            {compact(row.value)}
            {row.hint ? <em>{row.hint}</em> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------- 活跃热力图 */

const HEAT_WEEKS = 26

interface HeatCell {
  date: string
  tokens: number
  credits: number
  calls: number
  level: number
  future: boolean
}

function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/**
 * GitHub 贡献图那套布局：一列一周，一行一天（周日在最上）。
 * 格子按「列优先」顺序铺，正好对上 CSS 的 grid-auto-flow: column。
 */
function buildHeatmap(
  days: DayStat[],
  weeks: number
): { cells: HeatCell[]; start: string; end: string; activeDays: number } {
  const byDate = new Map(days.map((day) => [day.date, day]))
  const today = startOfToday()
  const todayKey = dayKeyOf(today)
  const lastSunday = shiftDays(today, -today.getDay())
  const firstSunday = shiftDays(lastSunday, -(weeks - 1) * 7)

  const cells: HeatCell[] = []
  let max = 0
  let activeDays = 0

  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      const key = dayKeyOf(shiftDays(firstSunday, week * 7 + day))
      const stat = byDate.get(key)
      const tokens = stat ? stat.inputTokens + stat.outputTokens : 0
      if (tokens > max) max = tokens
      if (tokens > 0) activeDays += 1
      cells.push({
        date: key,
        tokens,
        credits: stat?.credits ?? 0,
        calls: stat?.calls ?? 0,
        level: 0,
        future: key > todayKey
      })
    }
  }

  for (const cell of cells) cell.level = heatLevel(cell.tokens, max)
  return { cells, start: dayKeyOf(firstSunday), end: todayKey, activeDays }
}

function Heatmap({ days }: { days: DayStat[] }): JSX.Element {
  const { cells, start, end, activeDays } = useMemo(() => buildHeatmap(days, HEAT_WEEKS), [days])

  return (
    <>
      <div className="heat-wrap">
        <div className="heat-axis" aria-hidden="true">
          <span style={{ gridRow: 2 }}>一</span>
          <span style={{ gridRow: 4 }}>三</span>
          <span style={{ gridRow: 6 }}>五</span>
        </div>
        <div className="heatmap">
          {cells.map((cell) => (
            <div
              key={cell.date}
              className={`heat-cell${cell.future ? ' future' : ''}`}
              data-level={cell.level}
              title={
                cell.future
                  ? cell.date
                  : `${cell.date} · ${compact(cell.tokens)} token · ${formatCredits(cell.credits)} 积分 · ${cell.calls} 次调用`
              }
            />
          ))}
        </div>
      </div>
      <div className="heat-foot">
        <span>
          {start} ~ {end} · 活跃 {activeDays} 天
        </span>
        <span className="heat-legend">
          少
          <i data-level="0" />
          <i data-level="1" />
          <i data-level="2" />
          <i data-level="3" />
          <i data-level="4" />
          多
        </span>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ 主组件 */

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (force: boolean) => {
    const api = window.meter
    if (!api) {
      setError('未检测到 preload 注入的接口（window.meter），界面无法取数。')
      return
    }
    setBusy(true)
    try {
      const next = force ? await api.refresh() : await api.getSnapshot()
      setSnapshot(next)
      setError('')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  // 首个 effect 包 try/catch：effect 抛错又没有错误边界时，
  // React 会整棵树卸载，界面变成一片空白，极难定位。
  useEffect(() => {
    try {
      void load(false)
      const api = window.meter
      if (!api) return
      const off = api.onSnapshot((next) => setSnapshot(next))
      const timer = window.setInterval(() => setNow(Date.now()), 30_000)
      return () => {
        off()
        window.clearInterval(timer)
      }
    } catch (cause) {
      setError(String(cause))
      return
    }
  }, [load])

  const totals = snapshot?.totals
  const today = snapshot?.today

  const structureRows = useMemo<BarRow[]>(() => {
    if (!totals) return []
    return [
      { name: '输入', value: totals.inputTokens, color: '#378ADD' },
      { name: '· 缓存命中', value: totals.cachedTokens, color: '#85B7EB' },
      { name: '输出', value: totals.outputTokens, color: '#1D9E75' },
      { name: '· 思考', value: totals.reasoningTokens, color: '#BA7517' }
    ]
  }, [totals])

  const dayBars = useMemo(() => {
    const days = (snapshot?.days ?? []).slice(0, 14).reverse()
    const max = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens))
    const todayKey = new Date().toLocaleDateString('sv-SE')
    return days.map((day) => ({
      date: day.date,
      // 14 根柱子塞不下「M-D」这种标签，只留日号，完整日期交给 title
      label: day.date.slice(8),
      value: day.inputTokens + day.outputTokens,
      ratio: (day.inputTokens + day.outputTokens) / max,
      credits: day.credits,
      isToday: day.date === todayKey
    }))
  }, [snapshot?.days])

  if (error && !snapshot) {
    return (
      <div className="fatal">
        <strong>取数失败</strong>
        <div style={{ marginTop: 6 }}>{error}</div>
        <div style={{ marginTop: 8, color: '#a3705f' }}>
          界面本身是正常的，失败发生在读取用量数据这一步。点右上角重试，或检查数据目录是否存在。
        </div>
      </div>
    )
  }

  const activeRatio = snapshot?.active && snapshot.active.size > 0 ? snapshot.active.used / snapshot.active.size : 0
  const activeLevel = levelOf(activeRatio)

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <div className="app-title">Token 计量器</div>
          <div className="app-subtitle">
            {snapshot ? `更新于 ${formatClock(snapshot.generatedAt)} · ${relativeTime(snapshot.generatedAt, now)}` : '正在读取…'}
          </div>
        </div>
        <div className="header-actions">
          <button type="button" disabled={busy} onClick={() => void load(true)}>
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* 今日 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">今日</div>
            <div className="card-note">{today?.calls ?? 0} 次调用</div>
          </div>
          <div className="headline">
            <div className="headline-item">
              <div className="headline-value accent-token">
                {compact((today?.inputTokens ?? 0) + (today?.outputTokens ?? 0))}
                <span className="headline-unit">token</span>
              </div>
              <div className="headline-label">
                输入 {compact(today?.inputTokens ?? 0)} · 输出 {compact(today?.outputTokens ?? 0)}
              </div>
            </div>
            <div className="headline-item">
              <div className="headline-value accent-credit">
                {formatCredits(today?.credits ?? 0)}
                <span className="headline-unit">积分</span>
              </div>
              <div className="headline-label">
                今日比价 1 积分 ≈ {tokenPerCredit((today?.inputTokens ?? 0) + (today?.outputTokens ?? 0), today?.credits ?? 0)} token
              </div>
            </div>
          </div>
        </section>

        {/* 上下文水位 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">当前会话上下文</div>
            <div className="card-note">
              {snapshot?.active ? relativeTime(snapshot.active.updatedAt, now) : '无活跃会话'}
            </div>
          </div>
          {snapshot?.active ? (
            <>
              <div className="meter-head">
                <div className="session-title" title={snapshot.active.title}>
                  {snapshot.active.title}
                </div>
                <div className="meter-value">{percent(snapshot.active.used, snapshot.active.size)}%</div>
              </div>
              <div className="meter">
                <div
                  className={`meter-fill ${activeLevel}`}
                  style={{ width: `${Math.min(100, activeRatio * 100)}%` }}
                />
              </div>
              <div className="meter-foot">
                <span>
                  {grouped(snapshot.active.used)} / {grouped(snapshot.active.size)} token
                </span>
                <span>{snapshot.active.cwd || '—'}</span>
              </div>
            </>
          ) : (
            <div className="empty">没有正在进行的会话</div>
          )}
        </section>

        {/* Token 结构 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">Token 结构（累计）</div>
            <div className="card-note">缓存命中占输入 {percent(totals?.cachedTokens ?? 0, totals?.inputTokens ?? 0)}%</div>
          </div>
          <Bars rows={structureRows} />
        </section>

        {/* 近 14 天 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">近 14 天</div>
            <div className="card-note">
              累计 {compact((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))} token · {formatCredits(totals?.credits ?? 0)} 积分
            </div>
          </div>
          {dayBars.length ? (
            <div className="days">
              {dayBars.map((day) => (
                <div className="day-col" key={day.date} title={`${day.date} · ${compact(day.value)} token · ${formatCredits(day.credits)} 积分`}>
                  <div
                    className={`day-bar${day.isToday ? ' today' : ''}`}
                    style={{ height: `${Math.max(3, day.ratio * 100)}%` }}
                  />
                  <div className="day-label">{day.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">暂无数据</div>
          )}
        </section>

        {/* 活跃热力图 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">活跃热力图</div>
            <div className="card-note">近 26 周 · 按 token 深浅</div>
          </div>
          {(snapshot?.days.length ?? 0) > 0 ? (
            <Heatmap days={snapshot?.days ?? []} />
          ) : (
            <div className="empty">暂无数据</div>
          )}
        </section>

        {/* 模型分布 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">按模型</div>
            <div className="card-note">1 积分 ≈ {tokenPerCredit((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0), totals?.credits ?? 0)} token</div>
          </div>
          {snapshot?.models.length ? (
            <Bars
              rows={snapshot.models.slice(0, 5).map((model) => ({
                name: model.model,
                value: model.inputTokens + model.outputTokens,
                color: '#534AB7',
                hint: `${Math.round(model.credits)}分`
              }))}
            />
          ) : (
            <div className="empty">暂无数据</div>
          )}
        </section>

        {/* 项目分布 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">按项目</div>
            <div className="card-note">{snapshot?.projects.length ?? 0} 个</div>
          </div>
          {snapshot?.projects.length ? (
            <Bars
              rows={snapshot.projects.slice(0, 5).map((project) => ({
                name: projectLabel(project.projectDir, project.cwd),
                value: project.inputTokens + project.outputTokens,
                color: '#1D9E75',
                hint: `${project.sessions}会话`
              }))}
            />
          ) : (
            <div className="empty">暂无数据</div>
          )}
        </section>

        {/* 会话排行 */}
        <section className="card">
          <div className="card-head">
            <div className="card-title">会话排行</div>
            <div className="card-note">
              {snapshot?.totals.sessions ?? 0} 个会话 · {snapshot?.totals.dbTraces ?? 0} 个计费回合
            </div>
          </div>
          <div className="sessions">
            {(snapshot?.sessions ?? []).slice(0, 40).map((session) => {
              const tokens = session.inputTokens + session.outputTokens
              return (
                <div className="session-row" key={session.sessionId}>
                  <div className="session-main">
                    <div className="session-title" title={session.title}>
                      {session.title}
                    </div>
                    <div className="session-meta">
                      <span className="tag">{session.model}</span>
                      <span>{projectLabel(session.projectDir, session.cwd)}</span>
                      <span>{relativeTime(session.lastActivity, now)}</span>
                      <span>{session.calls} 次</span>
                      {session.contextSize > 0 ? <span>水位 {percent(session.contextUsed, session.contextSize)}%</span> : null}
                    </div>
                  </div>
                  <div className="session-numbers">
                    <div className="session-tokens">{compact(tokens)}</div>
                    <div className="session-credits">{formatCredits(session.credits)} 积分</div>
                  </div>
                </div>
              )
            })}
            {!snapshot?.sessions.length ? <div className="empty">暂无会话</div> : null}
          </div>
        </section>

        {snapshot?.warnings.length ? (
          <div className="notice">
            {snapshot.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        ) : null}

        {snapshot && snapshot.totals.unattributedCredits > 0 ? (
          <div className="notice">
            另有 {formatCredits(snapshot.totals.unattributedCredits)} 积分找不到对应的会话明细
            （{snapshot.totals.dbTraces} 个计费回合中，只有 {snapshot.totals.matchedTraces} 个能对上本地记录）。
            这些多半来自已经清理掉的会话。
          </div>
        ) : null}
      </div>
    </div>
  )
}
