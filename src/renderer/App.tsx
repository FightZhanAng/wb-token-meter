import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import type {
  AppInfo,
  DayStat,
  PendingReason,
  QuotaInfo,
  QuotaWindow,
  QuotaWindowKey,
  Snapshot,
  SourceKind,
  ThemeMode,
  UpdateState,
  UsageSample
} from '@shared/types'
import {
  compact,
  credits as formatCredits,
  dayKeyOf,
  formatClock,
  grouped,
  hasCredits,
  hasQuota,
  hasReasoning,
  hasTokens,
  percent,
  projectLabel,
  relativeTime,
  shiftDays,
  SOURCE_ORDER,
  sourceLabel,
  startOfToday,
  THEME_ORDER,
  themeLabel,
  themeShort,
  tokenPerCredit
} from '@shared/format'
import { describeReset, quotaLevel, quotaWindowLabel } from '@shared/opencode-quota'
import { updateBusy, updateNeedsAttention, updateStatusText } from '@shared/update'

/* ------------------------------------------------------------ 小工具 */

/**
 * 深色主题的氛围层：一层 3.5% 的颗粒（透明度全在 CSS 里，浅色下是 0）。
 *
 * 用内联 SVG 的 feTurbulence 而不是 data-URI 背景图：噪音本来就是画出来的，
 * 没必要为此引一份外部资源；而且 `default-src 'self'` 一旦收紧，data: 是第一个被挡的。
 * 这一层不接收任何事件，也不进无障碍树 —— 它只是材料。
 */
function Grain(): JSX.Element {
  return (
    <svg className="grain" aria-hidden="true" focusable="false">
      <filter id="wbtm-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#wbtm-grain)" />
    </svg>
  )
}

/** node 的平台名翻成用户认得的写法；其余原样返回，够用了 */
function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return platform
}

function levelOf(ratio: number): 'safe' | 'warn' | 'danger' {
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warn'
  return 'safe'
}

/**
 * 记录纸上的一个通道：左边窄栏写通道名，右边放数据，中间那条竖线是脊。
 * 面板上每一块内容都走这里 —— 没有卡片、没有阴影，结构全靠这条脊和横线。
 */
function Channel({
  name,
  note,
  live,
  children
}: {
  name: string
  /** 通道名下面那句实情（更新于 / 累计多少 / 命中率），没有就不写 */
  note?: ReactNode
  /** 正在记录的那个通道：名字前多一枚记录笔色的小方块 */
  live?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`ch${live ? ' live' : ''}`}>
      <h2 className="ch-name">{name}</h2>
      <div className="ch-body">
        {note ? <div className="ch-note">{note}</div> : null}
        {children}
      </div>
    </section>
  )
}

/**
 * 「这一轮还没读完」的占位。
 *
 * 为什么不直接画 0：那张全 0 快照是真的（主进程确实推上来了），但它**不是
 * 读完了读出 0**，而是一行都没读到。画成数字会让用户以为「今天真没用」，
 * 等十几秒数字跳出来才发现被骗。灰色块 + 一句说清在等什么，才是对的。
 *
 * `reason` 只有 key-scan 值得解释「为什么要等」——其余源都是毫秒级，
 * 一个转圈就够了，说多了反而像出了问题。
 */
function PendingBlock({ reason }: { reason: PendingReason }): JSX.Element {
  const [dots, setDots] = useState('')
  // 「…」用真实时钟推进，不用 CSS 动画：这一屏本来就要停在上面十几秒，
  // 动画在小窗里会一直跑，白耗一格 CPU
  useEffect(() => {
    if (reason !== 'key-scan') return
    const tick = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}·`)), 400)
    return () => clearInterval(tick)
  }, [reason])

  return (
    <div className="pending">
      <div className="pending-title">
        {reason === 'key-scan' ? '正在读取 TraeWork 的数据库密钥' : '正在读取用量数据'}
        <span className="pending-dots">{dots}</span>
      </div>
      <div className="pending-hint">
        {reason === 'key-scan'
          ? '这个源的账本是加密的，密钥只存在于 TraeWork 的进程内存里。首次启动要扫一遍它的内存（约 20 秒），拿到后本窗口一直有效。'
          : '稍候，数据马上就到。'}
      </div>
    </div>
  )
}

interface BarRow {
  name: string
  value: number
  color: string
  hint?: string
  /** 子项（缓存命中、思考）：缩进一格，不靠「·」这类符号提示层级 */
  sub?: boolean
  /** 覆盖默认的 compact 显示：积分带小数，compact 会把它圆成整数 */
  display?: string
}

function Bars({ rows }: { rows: BarRow[] }): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="bars">
      {rows.map((row) => (
        <div className={`bar-row${row.sub ? ' sub' : ''}`} key={row.name}>
          <div className="bar-name" title={row.name}>
            {row.name}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(row.value / max) * 100}%`, background: row.color }} />
          </div>
          <div className="bar-value">
            {row.display ?? compact(row.value)}
            {row.hint ? <em>{row.hint}</em> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 带红线区的仪表。70% / 90% 两条分界印在刻度槽上（CSS 背景），永远看得见；
 * 指针落在哪个区就染哪个区的颜色。这样「红」说的是「进红线区了」，
 * 而不是「我把整条进度条刷红了」—— 真实仪表就是这么读的。
 */
function Gauge({ ratio }: { ratio: number }): JSX.Element {
  const clamped = Math.min(1, Math.max(0, ratio))
  return (
    <div className="gauge" data-level={levelOf(clamped)}>
      <div className="gauge-fill" style={{ width: `${clamped * 100}%` }} />
      <div className="gauge-needle" style={{ left: `${clamped * 100}%` }} />
    </div>
  )
}

/* -------------------------------------------------------- 活跃热力图 */

const HEAT_WEEKS = 26

/** 热力图按什么量计深浅：token 源用 token，Qoder CN 这种只有积分的用它 */
type HeatMetric = 'tokens' | 'credits'

interface HeatCell {
  date: string
  /** 按 metric 选定的量（画深浅用） */
  value: number
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
  weeks: number,
  metric: HeatMetric
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
      const value = metric === 'credits' ? (stat?.credits ?? 0) : stat ? stat.inputTokens + stat.outputTokens : 0
      if (value > max) max = value
      if (value > 0) activeDays += 1
      cells.push({
        date: key,
        value,
        credits: stat?.credits ?? 0,
        calls: stat?.calls ?? 0,
        level: 0,
        future: key > todayKey
      })
    }
  }

  for (const cell of cells) cell.level = heatLevel(cell.value, max)
  return { cells, start: dayKeyOf(firstSunday), end: todayKey, activeDays }
}

function Heatmap({
  days,
  withCredits,
  metric
}: {
  days: DayStat[]
  withCredits: boolean
  metric: HeatMetric
}): JSX.Element {
  const { cells, start, end, activeDays } = useMemo(
    () => buildHeatmap(days, HEAT_WEEKS, metric),
    [days, metric]
  )
  const todayKey = dayKeyOf(startOfToday())

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
              className={`heat-cell${cell.future ? ' future' : ''}${cell.date === todayKey ? ' today' : ''}`}
              data-level={cell.level}
              title={
                cell.future
                  ? cell.date
                  : metric === 'credits'
                    ? `${cell.date} · ${formatCredits(cell.credits)} 积分 · ${cell.calls} 次调用`
                    : `${cell.date} · ${compact(cell.value)} token${withCredits ? ` · ${formatCredits(cell.credits)} 积分` : ''} · ${cell.calls} 次调用`
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

/* ------------------------------------------------- OpenCode Go 额度 */

/**
 * 折线颜色与粗细：窗口越长画得越重，5 小时窗口最轻，短线才不会压住长线。
 * 颜色走 CSS 变量 —— 写死十六进制的话深色主题下这几条线会糊在背景里。
 */
const TREND_SERIES: { key: QuotaWindowKey; color: string; width: number; opacity: number }[] = [
  { key: 'monthly', color: 'var(--d-in)', width: 2.4, opacity: 1 },
  { key: 'weekly', color: 'var(--d-think)', width: 1.8, opacity: 1 },
  { key: 'rolling', color: 'var(--d-rank)', width: 1.4, opacity: 0.85 }
]

/**
 * 折线画布。宽度只是个基准值 —— 配合 preserveAspectRatio="none" 横向拉满卡片，
 * 所以图里不能放文字（会被拉变形），刻度得用 HTML 摆在右边。
 */
const PLOT_W = 320
const PLOT_H = 120

/**
 * 纵轴按数据自适应。额度常年是个位数百分比，固定 0-100 会让曲线永远贴着底边、
 * 看不出走势；档位取 10 / 25 / 50 / 100 四档，五等分后刻度正好都落在整数上。
 */
function trendScale(history: UsageSample[]): { top: number; ticks: number[] } {
  let peak = 0
  for (const sample of history) {
    peak = Math.max(peak, sample.rolling, sample.weekly, sample.monthly)
  }
  const top = peak <= 10 ? 10 : peak <= 25 ? 25 : peak <= 50 ? 50 : 100
  const step = top / 5
  return { top, ticks: [0, step, step * 2, step * 3, step * 4, top] }
}

function QuotaRow({ win, now }: { win: QuotaWindow; now: number }): JSX.Element {
  const near = win.percent >= 90
  return (
    <div className={`quota-row${near ? ' danger' : ''}`}>
      <div className="quota-label">{quotaWindowLabel(win.key)}</div>
      <div className="quota-track">
        <div
          className={`quota-fill ${quotaLevel(win.percent)}`}
          style={{ width: `${Math.min(100, Math.max(0, win.percent))}%` }}
        />
      </div>
      <div className="quota-percent">{win.percent}%</div>
      <div className="quota-reset">
        <span>{describeReset(win.resetsAt, now)}</span>
        {near ? <em>接近上限</em> : null}
      </div>
    </div>
  )
}

function QuotaMeter({ quota, now }: { quota: QuotaInfo; now: number }): JSX.Element {
  if (!quota.windows.length) {
    // 没数据也没报错，那就是第一次请求还在路上 —— 别让用户以为接口坏了
    const pending = quota.fetchedAt === 0 && !quota.error
    return <div className="empty">{pending ? '正在查询额度…' : '还没有取到额度数据'}</div>
  }
  return (
    <div className="quota-rows">
      {quota.windows.map((win) => (
        <QuotaRow key={win.key} win={win} now={now} />
      ))}
    </div>
  )
}

function QuotaSource({ quota, now }: { quota: QuotaInfo; now: number }): JSX.Element {
  const never = quota.fetchedAt === 0
  return (
    <>
      <div className="quota-meta">
        <span>接口</span>
        <code>{quota.endpoint}</code>
      </div>
      <div className="quota-meta">
        <span>凭证</span>
        <code>{quota.credential}</code>
      </div>
      <div className="quota-meta">
        <span>更新</span>
        <span>
          {never
            ? quota.error
              ? '还没成功取到过'
              : '正在查询…'
            : `${formatClock(quota.fetchedAt)}（${relativeTime(quota.fetchedAt, now)}）`}
        </span>
      </div>
      <div className="quota-note">额度来自 opencode.ai 的在线接口，不读取本地用量文件。</div>
      {quota.stale ? (
        <div className="quota-notice">
          上次刷新失败：{quota.error}；显示的是 {formatClock(quota.fetchedAt)} 的数据。
        </div>
      ) : null}
      {never && quota.error ? (
        <div className="quota-notice">
          取不到额度：{quota.error}
          <br />
          在 opencode 里执行 <code>/connect</code> 连一次 OpenCode Go，凭证会写到 <code>{quota.credential}</code>。
        </div>
      ) : null}
    </>
  )
}

function QuotaTrend({ history }: { history: UsageSample[] }): JSX.Element {
  const { series, top, ticks } = useMemo(() => {
    const scale = trendScale(history)
    if (history.length < 2) return { series: [], ...scale }
    const first = history[0].t
    // 两条采样挤在同一毫秒时横轴会退化成一个点，兜个 1 毫秒
    const span = Math.max(1, history[history.length - 1].t - first)
    const series = TREND_SERIES.map((line) => ({
      ...line,
      points: history
        .map((sample) => {
          const x = ((sample.t - first) / span) * PLOT_W
          const y = PLOT_H - (Math.min(scale.top, Math.max(0, sample[line.key])) / scale.top) * PLOT_H
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    }))
    return { series, ...scale }
  }, [history])

  if (history.length < 2) return <div className="empty">还在积累数据，多刷新几次就能看到趋势</div>

  return (
    <>
      <div className="quota-trend">
        <svg
          className="trend-plot"
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="额度占用趋势"
        >
          {ticks.map((tick) => (
            <line
              key={tick}
              x1="0"
              x2={PLOT_W}
              y1={PLOT_H - (tick / top) * PLOT_H}
              y2={PLOT_H - (tick / top) * PLOT_H}
              /* 走 style 而不是属性：SVG 的呈现属性不解析 CSS 变量，深色下会留在浅色网格 */
              style={{ stroke: 'var(--rule-soft)' }}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map((line) => (
            <polyline
              key={line.key}
              points={line.points}
              fill="none"
              style={{ stroke: line.color }}
              strokeWidth={line.width}
              strokeOpacity={line.opacity}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <div className="trend-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ top: `${100 - (tick / top) * 100}%` }}>
              {Math.round(tick)}
            </span>
          ))}
        </div>
      </div>
      <div className="trend-legend">
        {TREND_SERIES.map((line) => (
          <span key={line.key}>
            <i style={{ background: line.color, height: `${line.width}px` }} />
            {quotaWindowLabel(line.key)}
          </span>
        ))}
      </div>
      <div className="trend-note">折线是应用运行期间在本地记的采样（额度没变也每半小时留一条），接口本身不提供历史。</div>
    </>
  )
}

function QuotaView({ quota, now }: { quota: QuotaInfo; now: number }): JSX.Element {
  return (
    <>
      <Channel
        name="额度"
        note={
          quota.stale
            ? '旧数据'
            : quota.fetchedAt
              ? `更新于 ${relativeTime(quota.fetchedAt, now)}`
              : quota.error
                ? '未取到数据'
                : '查询中'
        }
      >
        <QuotaMeter quota={quota} now={now} />
      </Channel>

      <Channel name="来源" note="联网查询">
        <QuotaSource quota={quota} now={now} />
      </Channel>

      <Channel name="趋势" note={`最近 7 天 · ${quota.history.length} 个采样点`}>
        <QuotaTrend history={quota.history} />
      </Channel>
    </>
  )
}

/* -------------------------------------------------------- 数据源切换 */

/**
 * 直接摆出来的源数量，其余收进「更多」。
 * 数据源独占顶栏第二行，横向放得下四个 —— 摆得越多，切一次源要点的次数越少。
 */
const VISIBLE_SOURCES = 4

function SourceSwitch({
  value,
  disabled,
  onChange
}: {
  value: SourceKind
  disabled: boolean
  onChange: (kind: SourceKind) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const head = SOURCE_ORDER.slice(0, VISIBLE_SOURCES)
  const tail = SOURCE_ORDER.slice(VISIBLE_SOURCES)
  // 当前源落在「更多」里时，那个按钮直接显示它的名字 —— 否则顶栏看不出在看哪一本账
  const inTail = tail.includes(value)

  const pick = (kind: SourceKind): void => {
    setOpen(false)
    if (kind !== value) onChange(kind)
  }

  return (
    <div className="source-switch" role="group" aria-label="数据源">
      {head.map((kind) => (
        <button
          key={kind}
          type="button"
          className={kind === value ? 'active' : ''}
          disabled={disabled}
          onClick={() => pick(kind)}
        >
          {sourceLabel(kind)}
        </button>
      ))}
      <button
        type="button"
        className={`source-more${inTail ? ' active' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {inTail ? sourceLabel(value) : '更多'}
        <i className="caret" aria-hidden="true" />
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="source-menu" role="menu">
            {tail.map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                className={kind === value ? 'active' : ''}
                onClick={() => pick(kind)}
              >
                {sourceLabel(kind)}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 外观 */

/** GitHub 官方 mark 的实心剪影，跟着 currentColor 走明暗两档 */
function GitHubGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

/** 三档各一枚记号：跟随系统是半明半暗的圆，浅色是太阳，深色是月牙 */
function ThemeGlyph({ mode }: { mode: ThemeMode }): JSX.Element {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="2.9" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M7 .8v1.9M7 11.3v1.9M.8 7h1.9M11.3 7h1.9" />
          <path d="M2.6 2.6l1.35 1.35M10.05 10.05l1.35 1.35M11.4 2.6l-1.35 1.35M3.95 10.05L2.6 11.4" />
        </g>
      </svg>
    )
  }
  if (mode === 'dark') {
    return (
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M11.7 8.9A5.2 5.2 0 0 1 5.1 2.3 5.6 5.6 0 1 0 11.7 8.9Z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 2a5 5 0 0 0 0 10Z" fill="currentColor" />
    </svg>
  )
}

/* ------------------------------------------------------------ 主组件 */

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [source, setSource] = useState<SourceKind>('workbuddy')
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [error, setError] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [autoCheck, setAutoCheck] = useState(true)
  const [autoDownload, setAutoDownload] = useState(false)
  /**
   * 「关于」只有两个会露脸的形态：下拉菜单、版本弹窗。
   * 合成一个状态就不用管「菜单没关又开弹窗」这种组合 —— 打开弹窗时菜单自然收掉了。
   */
  const [about, setAbout] = useState<'closed' | 'menu' | 'version'>('closed')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

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

  const switchSource = useCallback(
    async (kind: SourceKind) => {
      const api = window.meter
      if (!api) return
      // 先点亮按钮：主进程要重采一次才会推新快照，中间这段空窗不该让按钮没反应
      setSource(kind)
      setBusy(true)
      try {
        const next = await api.updateSettings({ source: kind })
        setSource(next.source)
        await load(false)
      } catch (cause) {
        setError(String(cause))
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  /** 系统 → 浅色 → 深色 → 系统。想要哪一档都能一键点到，不必去翻托盘菜单 */
  const cycleTheme = useCallback(async () => {
    const api = window.meter
    if (!api) return
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
    setTheme(next)
    try {
      const saved = await api.updateSettings({ theme: next })
      setTheme(saved.theme)
    } catch (cause) {
      setError(String(cause))
    }
  }, [theme])

  /** 标题栏那枚 GitHub 图标：交给系统浏览器打开，别在应用里嵌一层壳 */
  const openHome = useCallback(async () => {
    const api = window.meter
    if (!api) return
    try {
      await api.openHome()
    } catch (cause) {
      setError(String(cause))
    }
  }, [])

  // 首个 effect 包 try/catch：effect 抛错又没有错误边界时，
  // React 会整棵树卸载，界面变成一片空白，极难定位。
  useEffect(() => {
    try {
      void load(false)
      const api = window.meter
      if (!api) return
      void api
        .getSettings()
        .then((settings) => {
          setSource(settings.source)
          setTheme(settings.theme)
          setAutoCheck(settings.autoCheckUpdate)
          setAutoDownload(settings.autoDownloadUpdate)
        })
        .catch(() => undefined)
      void api.getUpdate().then(setUpdate).catch(() => undefined)
      void api.getAppInfo().then(setAppInfo).catch(() => undefined)
      const offSnapshot = api.onSnapshot((next) => setSnapshot(next))
      const offSettings = api.onSettings((settings) => {
        setSource(settings.source)
        setTheme(settings.theme)
        setAutoCheck(settings.autoCheckUpdate)
        setAutoDownload(settings.autoDownloadUpdate)
      })
      const offUpdate = api.onUpdate((next) => setUpdate(next))
      const timer = window.setInterval(() => setNow(Date.now()), 30_000)
      return () => {
        offSnapshot()
        offSettings()
        offUpdate()
        window.clearInterval(timer)
      }
    } catch (cause) {
      setError(String(cause))
      return
    }
  }, [load])

  // 弹层都能用 Esc 收掉 —— 菜单和弹窗都是「看一眼就关」的东西，
  // 逼用户把鼠标跑回去点遮罩或关闭按钮不值当
  useEffect(() => {
    if (about === 'closed') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAbout('closed')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [about])

  /** 「关于 → 退出」：和托盘里那一项走同一条 IPC（先置 isQuitting 再退出） */
  const quitApp = useCallback(async () => {
    const api = window.meter
    if (!api) return
    setAbout('closed')
    try {
      await api.quit()
    } catch (cause) {
      setError(String(cause))
    }
  }, [])

  /** 更新按钮的统一入口 —— 主进程会把最新状态回抛，顺便也广播给托盘 */
  const runUpdateAction = useCallback(async (action: 'check' | 'download' | 'install' | 'page') => {
    const api = window.meter
    if (!api) return
    try {
      if (action === 'check') setUpdate(await api.checkUpdate())
      else if (action === 'download') setUpdate(await api.downloadUpdate())
      else if (action === 'install') setUpdate(await api.installUpdate())
      else await api.openReleasePage()
    } catch (cause) {
      setError(String(cause))
    }
  }, [])

  const setUpdateFlag = useCallback(
    async (patch: { autoCheckUpdate?: boolean; autoDownloadUpdate?: boolean }) => {
      const api = window.meter
      if (!api) return
      // 先点亮开关，主进程落盘 + 广播之后再以它为准校正回来
      if (patch.autoCheckUpdate !== undefined) setAutoCheck(patch.autoCheckUpdate)
      if (patch.autoDownloadUpdate !== undefined) setAutoDownload(patch.autoDownloadUpdate)
      try {
        const saved = await api.updateSettings(patch)
        setAutoCheck(saved.autoCheckUpdate)
        setAutoDownload(saved.autoDownloadUpdate)
      } catch (cause) {
        setError(String(cause))
      }
    },
    []
  )

  const totals = snapshot?.totals
  const today = snapshot?.today
  // 显示口径跟着「正在展示的这份数据」走，而不是跟着开关走 ——
  // 切过去但还没拿到新快照的那一瞬间，不该把 WorkBuddy 的积分画到 Kimi Code 上
  const withCredits = hasCredits(snapshot?.kind ?? 'workbuddy')
  const withTokens = hasTokens(snapshot?.kind ?? 'workbuddy')
  const withReasoning = hasReasoning(snapshot?.kind ?? 'workbuddy')
  // 额度源拿不到 token 明细，面板整块换成额度视图
  const quotaView = hasQuota(snapshot?.kind ?? 'workbuddy')
  const quota = quotaView ? snapshot?.quota : undefined
  // 积分与未归因警告对额度源没有意义，留着只会让人以为漏看了数据
  const warnings = (snapshot?.warnings ?? []).filter((warning) => !quotaView || !warning.includes('积分'))
  // 主进程说这一轮还没读完（现在只有 traecn 的首次取密钥会这样）。
  // 卡在切源那一刻别误判成「读完是 0」——snapshot.kind 还没跟上 source 时，
  // 新源的那张 pending 快照还没到，此刻该说的是「正在读」而不是任何数字。
  const pending: PendingReason | null =
    snapshot?.pending ?? (snapshot && snapshot.kind !== source ? 'collect' : null)

  const structureRows = useMemo<BarRow[]>(() => {
    if (!totals) return []
    const rows: BarRow[] = [
      { name: '输入', value: totals.inputTokens, color: 'var(--d-in)' },
      { name: '缓存命中', value: totals.cachedTokens, color: 'var(--d-cache)', sub: true },
      { name: '输出', value: totals.outputTokens, color: 'var(--d-out)' }
    ]
    // Kimi Code / Reasonix / DSH 的 output 里已含思考、没有单独一项；
    // 留着只会是根 0 长度的空条
    if (withReasoning) {
      rows.push({ name: '思考', value: totals.reasoningTokens, color: 'var(--d-think)', sub: true })
    }
    return rows
  }, [totals, withReasoning])

  const dayBars = useMemo(() => {
    const byDate = new Map((snapshot?.days ?? []).map((day) => [day.date, day]))
    const today = startOfToday()
    /*
     * 补齐空档。只取「有数据的那些天」会让 14 根柱子等距排列 ——
     * 看起来是一条连续时间轴，实际日期却在跳（19、25、26、01…），图在骗人。
     * 缺的日子必须画成 0，横轴才是真的。
     */
    const range = Array.from({ length: 14 }, (_, index) => dayKeyOf(shiftDays(today, index - 13)))
    const values = range.map((key) => {
      const stat = byDate.get(key)
      const tokens = stat ? stat.inputTokens + stat.outputTokens : 0
      return {
        date: key,
        // 没有 token 的源（Qoder CN）柱子画积分 —— 那是它唯一的量
        value: withTokens ? tokens : (stat?.credits ?? 0),
        credits: stat?.credits ?? 0,
        calls: stat?.calls ?? 0
      }
    })
    const max = Math.max(1, ...values.map((item) => item.value))
    return values.map((item, index) => ({
      date: item.date,
      // 14 根柱子塞不下「M-D」这种标签，只留日号，完整日期交给 title
      label: item.date.slice(8),
      value: item.value,
      ratio: item.value / max,
      credits: item.credits,
      calls: item.calls,
      isToday: index === range.length - 1
    }))
  }, [snapshot?.days, withTokens])

  /**
   * 会话排行整块交给一个 useMemo，`.sessions` 下只留**一个**子节点。
   *
   * key 里带上序号：WorkBuddy 的快照里同一个 sessionId 可能出现两次
   * （collector 把 <id>.jsonl 和 <id>/subagents/*.jsonl 各推了一条），
   * 重复 key 会让 React 的对账丢掉这些节点 —— 切数据源时会话数一缩，
   * 上一批行就留在 DOM 里清不掉，同一屏上出现两种口径的会话。
   */
  const sessionRows = useMemo(() => {
    const sessions = (snapshot?.sessions ?? []).slice(0, 40)
    if (!sessions.length) return null
    return sessions.map((session, index) => {
      const tokens = session.inputTokens + session.outputTokens
      return (
        <div className="session-row" key={`${session.sessionId}#${index}`}>
          <div className="session-main">
            <div className="session-title" title={session.title}>
              {session.title}
            </div>
            <div className="session-meta">
              <span className="tag">{session.model}</span>
              <span>{projectLabel(session.projectDir, session.cwd)}</span>
              <span>{relativeTime(session.lastActivity, now)}</span>
              <span>{session.calls} 次</span>
              {session.contextSize > 0 ? (
                <span>水位 {percent(session.contextUsed, session.contextSize)}%</span>
              ) : session.contextRatio != null ? (
                <span>水位 {Math.round(session.contextRatio * 100)}%</span>
              ) : null}
            </div>
          </div>
          <div className="session-numbers">
            <div className="session-tokens">
              {/* 没有 token 的源这里报调用次数，积分数在下面一行 */}
              {withTokens ? compact(tokens) : `${session.calls} 次`}
            </div>
            {withCredits ? (
              <div className="session-credits">{formatCredits(session.credits)} 积分</div>
            ) : null}
          </div>
        </div>
      )
    })
  }, [snapshot?.sessions, now, withCredits, withTokens])

  if (error && !snapshot) {
    return (
      <div className="fatal">
        <strong>取数失败</strong>
        <div style={{ marginTop: 6 }}>{error}</div>
        <div style={{ marginTop: 8 }}>
          界面本身是正常的，失败发生在读取用量数据这一步。点右上角重试，或检查数据目录是否存在。
        </div>
      </div>
    )
  }

  // 水位比例：优先按 used/size 算（大多数源），Qoder CN 没有 token 绝对值，
  // 用它快照自带的比例
  const activeRatio =
    snapshot?.active == null
      ? 0
      : snapshot.active.size > 0
        ? snapshot.active.used / snapshot.active.size
        : (snapshot.active.ratio ?? 0)
  // 上限查不到时（模型不在本地 config 也不在 models.dev 目录里）size 是 0：
  // 水位只能报已用量，硬算一个百分比出来比不显示更糟
  const sizeKnown = (snapshot?.active?.size ?? 0) > 0
  // 只有比例的源（Qoder CN）：仪表照画，读数报百分比
  const ratioKnown = !sizeKnown && snapshot?.active?.ratio != null
  const todayTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0)
  const newTokens = Math.max(0, (today?.inputTokens ?? 0) - (today?.cachedTokens ?? 0))

  // 主进程还没回过状态时先摆一个空壳，免得底栏先闪一下再填
  const updateState: UpdateState = update ?? {
    status: 'idle',
    current: '',
    latest: '',
    percent: 0,
    message: '',
    checkedAt: 0,
    notes: '',
    canDownload: false
  }
  const updateWorking = updateBusy(updateState.status)
  const updateAlerts = updateNeedsAttention(updateState.status)

  // 「关于 → 版本」弹窗的内容。主进程还没答话时先摆省略号，不留空行
  const aboutRows: Array<[string, string]> = [
    [
      '运行模式',
      appInfo ? (appInfo.packaged ? '安装版（支持自动更新）' : '开发模式（更新检查在打包后才生效）') : '…'
    ],
    ['运行环境', appInfo ? `Electron ${appInfo.electron} · Chromium ${appInfo.chrome}` : '…'],
    ['Node', appInfo ? appInfo.node : '…'],
    ['系统', appInfo ? `${platformLabel(appInfo.platform)} ${appInfo.arch}` : '…'],
    ['配置文件', appInfo?.settingsFile || '…']
  ]

  return (
    <div className="app">
      <Grain />
      <header className="app-header">
        {/*
         * 纯窗口 chrome：整条只负责拖窗，右端就是系统三键（最小化 / 最大化 / 关闭）的位置。
         * 应用自己的标题和按钮一律放到下面一行 —— 跟三键同处一行，一旦系统换了缩放
         * 或者加了别的东西，两边就会互相压。
         * 左角只留一个「关于」：菜单栏就该待在标题栏里，它是这一格唯一的东西，
         * 和三键分处两头，谁也压不到谁。
         */}
        <div className="app-caption">
          <div className="app-about">
            <button
              type="button"
              className="about-entry"
              aria-haspopup="menu"
              aria-expanded={about === 'menu'}
              onClick={() => setAbout(about === 'menu' ? 'closed' : 'menu')}
            >
              关于
            </button>
            {about === 'menu' ? (
              <>
                <div className="menu-backdrop" onClick={() => setAbout('closed')} />
                <div className="about-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => setAbout('version')}>
                    版本
                    <span className="menu-hint">v{appInfo?.version || updateState.current || '—'}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={updateWorking}
                    onClick={() => {
                      setAbout('closed')
                      void runUpdateAction('check')
                    }}
                  >
                    检查更新
                    <span className="menu-hint" title={updateState.message || undefined}>
                      {updateStatusText(updateState)}
                    </span>
                  </button>
                  <span className="menu-rule" aria-hidden="true" />
                  <button type="button" role="menuitem" onClick={() => void quitApp()}>
                    退出
                  </button>
                </div>
              </>
            ) : null}
          </div>
          <div className="app-caption-guard" aria-hidden="true" />
        </div>
        <div className="app-id-row">
          <div className="app-header-main">
            <div className="app-title">Token 计量器</div>
            <div className="app-subtitle">
              {/* 切源后的空窗里快照的 kind 还停在上一本账：这时要明说「正在读取哪一本」，
                  不然按钮亮了、数字没动，看起来像点了没反应。显示口径仍跟着 snapshot.kind
                  走（见上），这里只是把「没到」说出来。 */}
              {!snapshot
                ? '正在读取…'
                : snapshot.kind !== source
                  ? `正在读取 ${sourceLabel(source)}…`
                  : `更新于 ${formatClock(snapshot.generatedAt)} · ${relativeTime(snapshot.generatedAt, now)}`}
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="icon-button"
              title="打开项目主页（GitHub）"
              aria-label="打开项目主页（GitHub）"
              onClick={() => void openHome()}
            >
              <GitHubGlyph />
            </button>
            <button
              type="button"
              className="theme-toggle"
              title={`外观：${themeLabel(theme)}（点击切换）`}
              aria-label={`外观：${themeLabel(theme)}，点击切换`}
              onClick={() => void cycleTheme()}
            >
              <ThemeGlyph mode={theme} />
              {themeShort(theme)}
            </button>
            <button type="button" disabled={busy} onClick={() => void load(true)}>
              {busy ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>
        {/* 数据源单独占一行：它是这一页的主导航，挤在标题旁边只会把标题压成省略号 */}
        <div className="app-nav">
          <SourceSwitch value={source} disabled={busy} onChange={(kind) => void switchSource(kind)} />
        </div>
      </header>

      <div className="app-body">
        {/* 还没读完这一轮：整块画载入态。这一段不能画数字 —— 全 0 快照是真的，
            但它不是「读完了读出 0」，画成数字会让人以为今天真没用。
            注意 quotaView 排在前面：额度源那条链路是联网轮询，没有 pending。 */}
        {pending ? (
          <Channel name="载入中">
            <PendingBlock reason={pending} />
          </Channel>
        ) : quotaView ? (
          quota ? (
            <QuotaView quota={quota} now={now} />
          ) : (
            <Channel name="额度">
              <div className="empty">还没有取到额度数据</div>
            </Channel>
          )
        ) : (
          <>
            {/* 今日 —— 正在记录的那个通道 */}
            <Channel name="今日" live>
              <div className="counter">
                {!withTokens ? (
                  /* Qoder CN 只有积分：大数报积分，副行报调用次数 */
                  <div className="counter-main">
                    <div className="headline-value">
                      {formatCredits(today?.credits ?? 0)}
                      <span className="unit">积分</span>
                    </div>
                    <div className="counter-sub">{today?.calls ?? 0} 次调用</div>
                  </div>
                ) : (
                  <>
                    <div className="counter-main">
                      <div className="headline-value">
                        {compact(todayTokens)}
                        <span className="unit">token</span>
                      </div>
                      <div className="counter-sub">
                        输入 {compact(today?.inputTokens ?? 0)} · 输出 {compact(today?.outputTokens ?? 0)} ·{' '}
                        {today?.calls ?? 0} 次
                      </div>
                    </div>
                    {withCredits ? (
                      <div className="counter-side">
                        <div className="headline-value">
                          {formatCredits(today?.credits ?? 0)}
                          <span className="unit">积分</span>
                        </div>
                        <div className="counter-sub">1 积分 ≈ {tokenPerCredit(todayTokens, today?.credits ?? 0)} token</div>
                      </div>
                    ) : (
                      <div className="counter-side">
                        <div className="headline-value">
                          {percent(today?.cachedTokens ?? 0, today?.inputTokens ?? 0)}%
                          <span className="unit">缓存命中</span>
                        </div>
                        <div className="counter-sub">
                          命中 {compact(today?.cachedTokens ?? 0)} · 新增 {compact(newTokens)}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </Channel>

            {/* 上下文水位 —— 带红线区的仪表 */}
            <Channel
              name="上下文"
              note={snapshot?.active ? relativeTime(snapshot.active.updatedAt, now) : '无活跃会话'}
            >
              {snapshot?.active ? (
                <>
                  <div className="gauge-head">
                    <div className="gauge-title" title={snapshot.active.title}>
                      {snapshot.active.title}
                    </div>
                    <div className="gauge-readout">
                      {sizeKnown ? (
                        <>
                          {percent(snapshot.active.used, snapshot.active.size)}%
                        </>
                      ) : ratioKnown ? (
                        <>{Math.round((snapshot.active.ratio ?? 0) * 100)}%</>
                      ) : (
                        <>
                          {compact(snapshot.active.used)}
                          <span className="unit">token</span>
                        </>
                      )}
                    </div>
                  </div>
                  {sizeKnown || ratioKnown ? <Gauge ratio={activeRatio} /> : null}
                  <div className="gauge-foot">
                    <span>
                      {sizeKnown
                        ? `${grouped(snapshot.active.used)} / ${grouped(snapshot.active.size)} token`
                        : ratioKnown
                          ? '水位比例来自会话快照，token 绝对值不提供'
                          : '模型上限未知，只报已用量'}
                    </span>
                    <span title={snapshot.active.cwd || undefined}>{snapshot.active.cwd || '—'}</span>
                  </div>
                </>
              ) : (
                <div className="empty">没有正在进行的会话</div>
              )}
            </Channel>

            {/* Token 结构 —— 没有 token 的源（Qoder CN）整块收起 */}
            {withTokens ? (
              <Channel
                name="结构"
                note={`累计 ${compact((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))} token${
                  withCredits ? ` · ${formatCredits(totals?.credits ?? 0)} 积分` : ''
                }`}
              >
                <Bars rows={structureRows} />
              </Channel>
            ) : null}

            {/* 近 14 天 */}
            <Channel
              name="14 天"
              note={
                withTokens
                  ? `缓存命中占输入 ${percent(totals?.cachedTokens ?? 0, totals?.inputTokens ?? 0)}%`
                  : `累计 ${formatCredits(totals?.credits ?? 0)} 积分`
              }
            >
              {dayBars.some((day) => day.value > 0) ? (
                <div className="days">
                  {dayBars.map((day) => (
                    <div
                      className="day-col"
                      key={day.date}
                      title={
                        withTokens
                          ? `${day.date} · ${compact(day.value)} token${withCredits ? ` · ${formatCredits(day.credits)} 积分` : ''}`
                          : `${day.date} · ${formatCredits(day.credits)} 积分 · ${day.calls} 次调用`
                      }
                    >
                      <div
                        className={`day-bar${day.isToday ? ' today' : ''}`}
                        /*
                         * 没有用量的日子画成 0 高度，让基线自己说话 ——
                         * 给个最小高度会让「那天没干活」和「那天干得很少」长得一模一样。
                         * 只有今天例外：它是个「你在这儿」的记号，不是一根数据柱，
                         * 所以哪怕今天没用量也留一小截记录笔色。
                         */
                        style={{
                          height: day.value > 0 ? `${Math.max(3, day.ratio * 100)}%` : day.isToday ? '3px' : '0px'
                        }}
                      />
                      <div className="day-label">{day.label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">最近 14 天没有用量</div>
              )}
            </Channel>

            {/* 活跃热力图 */}
            <Channel name="活跃">
              {(snapshot?.days.length ?? 0) > 0 ? (
                <Heatmap
                  days={snapshot?.days ?? []}
                  withCredits={withCredits}
                  metric={withTokens ? 'tokens' : 'credits'}
                />
              ) : (
                <div className="empty">暂无数据</div>
              )}
            </Channel>

            {/* 模型分布 */}
            <Channel
              name="模型"
              note={
                withCredits && withTokens
                  ? `1 积分 ≈ ${tokenPerCredit((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0), totals?.credits ?? 0)} token`
                  : undefined
              }
            >
              {snapshot?.models.length ? (
                <Bars
                  rows={snapshot.models.slice(0, 5).map((model) => ({
                    name: model.model,
                    value: withTokens ? model.inputTokens + model.outputTokens : model.credits,
                    display: withTokens ? undefined : formatCredits(model.credits),
                    color: 'var(--d-rank)',
                    hint: withCredits
                      ? withTokens
                        ? `${Math.round(model.credits)}分`
                        : `${model.calls} 次`
                      : `${model.calls} 次`
                  }))}
                />
              ) : (
                <div className="empty">暂无数据</div>
              )}
            </Channel>

            {/* 项目分布 */}
            <Channel name="项目">
              {snapshot?.projects.length ? (
                <Bars
                  rows={snapshot.projects.slice(0, 5).map((project) => ({
                    name: projectLabel(project.projectDir, project.cwd),
                    value: withTokens ? project.inputTokens + project.outputTokens : project.credits,
                    display: withTokens ? undefined : formatCredits(project.credits),
                    color: 'var(--d-rank)',
                    hint: `${project.sessions}会话`
                  }))}
                />
              ) : (
                <div className="empty">暂无数据</div>
              )}
            </Channel>

            {/* 会话排行 */}
            <Channel
              name="会话"
              note={`${snapshot?.totals.sessions ?? 0} 个 · ${
                withCredits
                  ? `${snapshot?.totals.dbTraces ?? 0} 个计费回合`
                  : `${snapshot?.totals.calls ?? 0} 次调用`
              }`}
            >
              <div className="sessions">{sessionRows ?? <div className="empty">暂无会话</div>}</div>
            </Channel>

            {/* 数据来源 —— 没有 token 的源（Qoder CN）在这里交代账本口径 */}
            {!withTokens && snapshot ? (
              <Channel name="来源" note="本地读取">
                <div className="quota-meta">
                  <span>目录</span>
                  <code>{snapshot.source.dir}</code>
                </div>
                <div className="quota-meta">
                  <span>账本</span>
                  <span>
                    {snapshot.source.files} 个会话文件 · {snapshot.totals.calls} 次请求
                  </span>
                </div>
                <div className="quota-note">
                  Qoder CN 的账本只回积分与上下文水位，不提供 token 明细 ——
                  输入 / 输出 / 缓存这些通道没有数据可画。用量全部来自本地会话日志。
                </div>
              </Channel>
            ) : null}
          </>
        )}

        {warnings.length ? (
          <div className="notice">
            {warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        ) : null}

        {withCredits && snapshot && snapshot.totals.unattributedCredits > 0 ? (
          <div className="notice">
            另有 {formatCredits(snapshot.totals.unattributedCredits)} 积分找不到对应的会话明细
            （{snapshot.totals.dbTraces} 个计费回合中，只有 {snapshot.totals.matchedTraces} 个能对上本地记录）。
            这些多半来自已经清理掉的会话。
          </div>
        ) : null}
      </div>

      {/*
        底栏固定在窗口底部（body 才是滚动区），版本号与更新状态始终看得见 ——
        埋进滚动内容里就等于藏起来了，而「我这是哪个版本」正是要找的时候才看的信息。
      */}
      <footer className="app-footer">
        <div className="foot-row">
          <span className="foot-version" title="当前运行的版本">
            v{updateState.current || '—'}
          </span>
          <span
            className={`foot-state${updateAlerts ? ' alert' : ''}`}
            data-status={updateState.status}
            title={updateState.notes || undefined}
          >
            {updateStatusText(updateState)}
          </span>

          <span className="foot-actions">
            {updateWorking ? (
              <button type="button" className="ghost" disabled>
                {updateState.status === 'downloading' ? '下载中…' : '检查中…'}
              </button>
            ) : updateState.status === 'downloaded' ? (
              <button type="button" className="primary" onClick={() => void runUpdateAction('install')}>
                重启并安装
              </button>
            ) : updateState.status === 'available' && updateState.canDownload ? (
              <button type="button" className="primary" onClick={() => void runUpdateAction('download')}>
                下载更新
              </button>
            ) : updateState.status === 'unsupported' ? (
              <button type="button" className="ghost" onClick={() => void runUpdateAction('page')}>
                打开发布页
              </button>
            ) : (
              <button
                type="button"
                className="ghost"
                title={updateState.message || undefined}
                onClick={() => void runUpdateAction('check')}
              >
                检查更新
              </button>
            )}

            {updateState.status === 'available' && updateState.canDownload ? (
              <button type="button" className="ghost" onClick={() => void runUpdateAction('page')}>
                发布页
              </button>
            ) : null}
          </span>
        </div>

        <div className="foot-row switches">
          <label className="switch">
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(event) => void setUpdateFlag({ autoCheckUpdate: event.target.checked })}
            />
            启动时自动检查更新
          </label>
          <label className={`switch${autoCheck ? '' : ' muted'}`}>
            <input
              type="checkbox"
              checked={autoDownload}
              disabled={!autoCheck}
              onChange={(event) => void setUpdateFlag({ autoDownloadUpdate: event.target.checked })}
            />
            发现新版本后自动下载
          </label>
        </div>
      </footer>

      {/*
        「关于 → 版本」：一个盖住整页的弹层。刻意做成应用自己的样式而不是系统对话框 ——
        系统对话框是另一套外皮，跟这块记录纸摆在一起像两个程序。
      */}
      {about === 'version' ? (
        <div className="about-layer" role="dialog" aria-modal="true" aria-label="关于 Token 计量器">
          <div className="menu-backdrop" onClick={() => setAbout('closed')} />
          <div className="about-card">
            <div className="about-head">
              <span className="about-name">Token 计量器</span>
              <span className="about-number">v{appInfo?.version || updateState.current || '—'}</span>
            </div>
            <div className="about-rows">
              {aboutRows.map(([label, value]) => (
                <div className="about-row" key={label}>
                  <span className="about-key">{label}</span>
                  <span
                    className={`about-value${label === '配置文件' ? ' path' : ''}`}
                    title={value}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="about-actions">
              <button type="button" className="ghost" onClick={() => void runUpdateAction('page')}>
                打开发布页
              </button>
              <button type="button" className="primary" onClick={() => setAbout('closed')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
