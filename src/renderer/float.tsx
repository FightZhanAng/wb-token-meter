import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { CAPSULE_THEME_ORDER, capsuleThemeLabel, capsuleThemeShort, resolveCapsuleTheme } from '@shared/capsule'
import {
  compact,
  credits as formatCredits,
  dayKeyOf,
  formatClock,
  hasCredits,
  hasQuota,
  hasTokens,
  percent,
  relativeTime,
  shiftDays,
  sourceLabel,
  startOfToday
} from '@shared/format'
import { CAPSULE_SIZES, CARD_GAP, FLOAT_CARD, SHADOW_PAD } from '@shared/layout'
import { describeReset, quotaWindowLabel, windowOf } from '@shared/opencode-quota'
import type {
  CapsuleTheme,
  DayStat,
  FloatCardSide,
  QuotaInfo,
  QuotaWindow,
  Settings,
  Snapshot,
  SourceKind
} from '@shared/types'
import './float.css'

const meter = window.meter

/*
 * 给 box-shadow 留绘制空间的那圈留白，直接由 layout.ts 的常数写进来。
 * 别在 CSS 里再抄一份 12px —— 抄的那份迟早会和主进程算窗口尺寸用的常数漂开，
 * 表现是阴影被窗口边界切平、胶囊外面像糊了一层底色。
 */
document.body.style.padding = `${SHADOW_PAD}px`

/*
 * 胶囊外观落到 <html data-capsule> 上 —— CSS 只认这一个属性。
 *
 * 这里**不用**面板那套 `data-theme`：面板主题跟着 nativeTheme 走，胶囊是另一条轴
 * （见 shared/capsule.ts）。首帧的档位由 preload 从启动参数里带来，这里是兜底 ——
 * 模块顶层就跑，赶在 createRoot 之前，也就赶在第一次合成之前。
 */
function applyCapsuleTheme(theme: CapsuleTheme): void {
  const root = document.documentElement
  root.dataset.capsuleTheme = theme
  root.dataset.capsule = resolveCapsuleTheme(theme, matchMedia('(prefers-color-scheme: dark)').matches)
}

applyCapsuleTheme(meter?.initialCapsuleTheme ?? 'auto')

/** `auto` 要跟着系统深浅走，所以只有这一档需要额外听信号 */
function useCapsuleTheme(theme: CapsuleTheme): void {
  useEffect(() => {
    applyCapsuleTheme(theme)
    if (theme !== 'auto') return
    const query = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyCapsuleTheme(theme)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])
}

/* ------------------------------------------------------------ 读数 */

/**
 * 胶囊与卡片共用同一份读数。
 *
 * 两边各算一遍是这类界面最容易长出来的暗病：改了胶囊的取数口径忘了改卡片，
 * 于是同一个数字在上下两层显示得不一样，而且没人会立刻发现。
 */
interface Readings {
  kind: SourceKind
  withCredits: boolean
  withTokens: boolean
  quota: QuotaInfo | undefined
  rolling: QuotaWindow | null
  todayTokens: number
  calls: number
  credits: number
  cachedShare: number
  /** 水位比例 0..1，给圆环与仪表共用 */
  ratio: number
  /** 水位的百分比读数；取不到时为空串 */
  waterMark: string
  /** 水位的文字口径（已用 / 上限）；没有活跃会话时为 null */
  waterNote: string | null
}

function readingsOf(snapshot: Snapshot | null): Readings {
  const kind = snapshot?.kind ?? 'workbuddy'
  const withCredits = hasCredits(kind)
  const withTokens = hasTokens(kind)
  const quota = hasQuota(kind) ? snapshot?.quota : undefined
  const rolling = quota ? (windowOf(quota.windows, 'rolling') ?? quota.windows[0] ?? null) : null
  const active = snapshot?.active
  const todayTokens = (snapshot?.today.inputTokens ?? 0) + (snapshot?.today.outputTokens ?? 0)
  const calls = snapshot?.today.calls ?? 0
  const credits = snapshot?.today.credits ?? 0

  // 额度源没有会话，圆环改报 5 小时窗口的占用 —— 阈值 0.9 / 0.7 与 quotaLevel 同档
  const ratio = quota
    ? (rolling?.percent ?? 0) / 100
    : active
      ? active.size > 0
        ? active.used / active.size
        : (active.ratio ?? 0)
      : 0

  // 水位角标：size 未知时按 Qoder CN 的比例报，两者都没有就不报
  const waterMark = active
    ? active.size > 0
      ? `${percent(active.used, active.size)}%`
      : active.ratio != null
        ? `${Math.round(active.ratio * 100)}%`
        : ''
    : ''
  const waterNote = active
    ? active.size > 0
      ? `${compact(active.used)} / ${compact(active.size)}`
      : active.ratio != null
        ? '按快照水位'
        : `${compact(active.used)} token`
    : null

  return {
    kind,
    withCredits,
    withTokens,
    quota,
    rolling,
    todayTokens,
    calls,
    credits,
    cachedShare: percent(snapshot?.today.cachedTokens ?? 0, snapshot?.today.inputTokens ?? 0),
    ratio,
    waterMark,
    waterNote
  }
}

/* ------------------------------------------------------------ 圆环 */

/**
 * 上下文水位圆环：颜色随水位从墨蓝转琥珀再转红 —— 和面板上那把仪表的分区
 * 是同一套语义，两处对得上。
 * 颜色走 style 而不是 SVG 呈现属性：后者不解析 CSS 变量，深色下会留在浅色值。
 */
function WaterRing({ ratio }: { ratio: number }): JSX.Element {
  const radius = 13
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, ratio))
  const color = clamped >= 0.9 ? 'var(--alarm)' : clamped >= 0.7 ? 'var(--warn)' : 'var(--d-in)'

  return (
    <svg className="ring" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r={radius} fill="none" style={{ stroke: 'var(--track)' }} strokeWidth="4" />
      <circle
        cx="16"
        cy="16"
        r={radius}
        fill="none"
        style={{ stroke: color }}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform="rotate(-90 16 16)"
      />
    </svg>
  )
}

/* ------------------------------------------------------------ 卡片 */

/**
 * 近 7 天的迷你柱。口径和面板上的「14 天」同一套：**空档要画成 0**，
 * 只画有数据的日子会让 7 根柱子等距排列，看着像条连续时间轴，实际日期在跳。
 */
function sparkOf(
  days: DayStat[],
  withTokens: boolean
): Array<{ key: string; ratio: number; today: boolean; title: string }> {
  const byDate = new Map(days.map((day) => [day.date, day]))
  const today = startOfToday()
  const bars = Array.from({ length: 7 }, (_, index) => {
    const key = dayKeyOf(shiftDays(today, index - 6))
    const stat = byDate.get(key)
    const value = stat ? (withTokens ? stat.inputTokens + stat.outputTokens : stat.credits) : 0
    return {
      key,
      value,
      today: index === 6,
      title: withTokens
        ? `${key} · ${compact(value)} token · ${stat?.calls ?? 0} 次`
        : `${key} · ${formatCredits(value)} 积分 · ${stat?.calls ?? 0} 次`
    }
  })
  const max = Math.max(1, ...bars.map((bar) => bar.value))
  return bars.map((bar) => ({ ...bar, ratio: bar.value / max }))
}

function levelOf(ratio: number): 'safe' | 'warn' | 'danger' {
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warn'
  return 'safe'
}

function Card({
  snapshot,
  readings,
  side,
  alignRight,
  theme,
  onCycleTheme,
  onCollapse
}: {
  snapshot: Snapshot | null
  readings: Readings
  side: FloatCardSide
  alignRight: boolean
  theme: CapsuleTheme
  onCycleTheme: () => void
  onCollapse: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const { kind, withCredits, withTokens, quota, rolling, todayTokens, calls, credits, cachedShare } = readings
  const now = Date.now()
  const bars = useMemo(() => sparkOf(snapshot?.days ?? [], withTokens), [snapshot?.days, withTokens])
  const water = Math.min(100, Math.max(0, Math.round(readings.ratio * 100)))

  const refresh = useCallback(async () => {
    if (!meter) return
    setBusy(true)
    try {
      await meter.refresh()
    } catch {
      /* 取数失败由主进程记日志；卡片只活几秒，不在这儿铺错误信息 */
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div
      className="card"
      data-side={side}
      data-align={alignRight ? 'right' : 'left'}
      style={{ width: FLOAT_CARD.width, height: FLOAT_CARD.height }}
    >
      <header className="card-head">
        <i className="live" aria-hidden="true" />
        <span className="card-src">{sourceLabel(kind)}</span>
        <button
          type="button"
          className="card-icon theme"
          title={`胶囊主题：${capsuleThemeLabel(theme)}（点击切换）`}
          aria-label={`胶囊主题：${capsuleThemeLabel(theme)}，点击切换`}
          onClick={onCycleTheme}
        >
          <i className="swatch" aria-hidden="true" />
          {capsuleThemeShort(theme)}
        </button>
        <button type="button" className="card-icon" title="收起卡片" aria-label="收起卡片" onClick={onCollapse}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="card-hero">
        <div className="hero-main">
          {quota && rolling ? (
            <>
              <span className="hero-value">
                {rolling.percent}
                <em>%</em>
              </span>
              <span className="hero-unit">{quotaWindowLabel(rolling.key)}额度</span>
            </>
          ) : withTokens ? (
            <>
              <span className="hero-value">{compact(todayTokens)}</span>
              <span className="hero-unit">token</span>
            </>
          ) : (
            <>
              <span className="hero-value">{formatCredits(credits)}</span>
              <span className="hero-unit">积分</span>
            </>
          )}
        </div>
        <div className="hero-side">
          {quota ? (
            <>
              <div>{quota.stale ? '旧数据' : describeReset(rolling?.resetsAt ?? 0, now)}</div>
              <div className="muted">{quota.fetchedAt ? relativeTime(quota.fetchedAt, now) : '未取到'}</div>
            </>
          ) : (
            <>
              {withCredits ? <div>{formatCredits(credits)} 积分</div> : null}
              <div className="muted">
                {calls} 次
                {cachedShare > 0 ? ` · 命中 ${cachedShare}%` : ''}
              </div>
            </>
          )}
        </div>
      </div>

      {quota ? (
        <div className="card-rows">
          {(quota.windows ?? []).map((win) => (
            <div className="cell" key={win.key}>
              <span className="cell-k">{quotaWindowLabel(win.key)}</span>
              <span className={`cell-v${win.percent >= 90 ? ' danger' : ''}`}>{win.percent}%</span>
            </div>
          ))}
        </div>
      ) : withTokens ? (
        <div className="card-rows">
          <div className="cell">
            <span className="cell-k">
              <i className="dot" style={{ background: 'var(--d-in)' }} />
              输入
            </span>
            <span className="cell-v">{compact(snapshot?.today.inputTokens ?? 0)}</span>
          </div>
          <div className="cell">
            <span className="cell-k">
              <i className="dot" style={{ background: 'var(--d-out)' }} />
              输出
            </span>
            <span className="cell-v">{compact(snapshot?.today.outputTokens ?? 0)}</span>
          </div>
          <div className="cell">
            <span className="cell-k">
              <i className="dot" style={{ background: 'var(--d-cache)' }} />
              缓存
            </span>
            <span className="cell-v">{compact(snapshot?.today.cachedTokens ?? 0)}</span>
          </div>
        </div>
      ) : null}

      {quota ? null : (
        <div className="card-gauge">
          <div className="gauge-line">
            <span className="card-k">上下文</span>
            <span className="gauge-bar" data-level={levelOf(readings.ratio)}>
              <i className="gauge-fill" style={{ width: `${water}%` }} />
              <i className="gauge-needle" style={{ left: `${water}%` }} />
            </span>
            <b className="gauge-num">{readings.waterMark || '—'}</b>
          </div>
          <div className="gauge-note" title={snapshot?.active?.title || undefined}>
            {snapshot?.active
              ? `${readings.waterNote} · ${snapshot.active.title || '未命名会话'}`
              : '当前无活跃会话'}
          </div>
        </div>
      )}

      <div className="card-spark">
        <span className="card-k">近 7 天</span>
        <span className="spark">
          {bars.map((bar) => (
            <i
              key={bar.key}
              className={`${bar.ratio > 0 ? '' : 'zero'}${bar.today ? ' today' : ''}`}
              title={bar.title}
              style={{
                /*
                 * 没有用量的日子留一道 2px 的底线（灰色），不画成 0 ——
                 * 卡片上只有 7 根柱子，「什么都没有」和「那天没干活」在这么小的
                 * 尺度上必须能分开看，否则一片空白分不清是没数据还是画坏了。
                 * 今天那根只给最小高度：它是个「你在这儿」的记号，不是数据柱。
                 */
                height: bar.ratio > 0 ? `${Math.max(6, Math.round(bar.ratio * 100))}%` : undefined
              }}
            />
          ))}
        </span>
      </div>

      <footer className="card-foot">
        <span className="foot-time">
          {snapshot
            ? `${formatClock(snapshot.generatedAt)} · ${relativeTime(snapshot.generatedAt, now)}`
            : '正在读取…'}
        </span>
        <button type="button" className="ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? '刷新中' : '刷新'}
        </button>
        <button type="button" className="primary" onClick={() => meter?.openPanel()}>
          打开面板
        </button>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------ 胶囊 */

function Capsule({
  readings,
  size,
  expanded,
  dragging,
  onDragStateChange
}: {
  readings: Readings
  size: { width: number; height: number }
  expanded: boolean
  dragging: boolean
  onDragStateChange(next: boolean): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  // 拖动与单击共用一套指针事件：
  // 位移超过阈值算拖动，否则算单击。用 CSS 的 -webkit-app-region: drag
  // 会把 click 整个吃掉，就没法「点击展开卡片」了。
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let pressed = false
    let moved = false
    let suppress = false
    let lastX = 0
    let lastY = 0

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      pressed = true
      moved = false
      /*
       * 卡片开着时按一下胶囊：先把卡片收掉，这一次按下就到此为止。
       * 不抑制的话，原地松手又会被当成单击，卡片刚收就又弹开。
       */
      suppress = expandedRef.current
      if (suppress) meter?.collapseFloatCard()
      lastX = event.screenX
      lastY = event.screenY
      try {
        el.setPointerCapture(event.pointerId)
      } catch {
        /* 某些环境不支持捕获，退化成普通事件也能用 */
      }
    }

    const onMove = (event: PointerEvent): void => {
      if (!pressed) return
      const dx = event.screenX - lastX
      const dy = event.screenY - lastY
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true
        // 拖动必然收起卡片：窗口在动，卡片跟着跑只会让人抓不住
        meter?.collapseFloatCard()
        onDragStateChange(true)
      }
      if (!moved) return
      lastX = event.screenX
      lastY = event.screenY
      meter?.moveFloat(dx, dy)
    }

    const onUp = (event: PointerEvent): void => {
      if (!pressed) return
      pressed = false
      try {
        el.releasePointerCapture(event.pointerId)
      } catch {
        /* 忽略 */
      }
      if (moved) {
        moved = false
        onDragStateChange(false)
        return
      }
      if (suppress) {
        suppress = false
        return
      }
      meter?.toggleFloatCard()
    }

    const onContextMenu = (event: MouseEvent): void => {
      // 右键出菜单，和托盘那份完全一致
      event.preventDefault()
      meter?.collapseFloatCard()
      meter?.openFloatMenu()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('contextmenu', onContextMenu)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [onDragStateChange])

  const { rolling, withTokens, withCredits } = readings

  return (
    <div
      ref={ref}
      className={`capsule${dragging ? ' dragging' : ''}${expanded ? ' open' : ''}`}
      style={{ width: size.width, height: size.height }}
      title="拖动移动 · 单击展开详情 · 右键菜单"
    >
      <WaterRing ratio={readings.ratio} />
      <div className="readout">
        {readings.quota ? (
          <>
            <div className="tokens">
              {rolling ? `${rolling.percent}%` : '—'}
              <em>{quotaWindowLabel(rolling?.key ?? 'rolling')}</em>
            </div>
            {/* 快照每 20 秒推一次，重置文案跟着这一次渲染的时间算就够了，不必再挂个计时器 */}
            <div className="credits plain">{describeReset(rolling?.resetsAt ?? 0, Date.now())}</div>
          </>
        ) : (
          <>
            <div className="tokens">
              {withTokens ? (
                <>
                  {compact(readings.todayTokens)}
                  <em>token</em>
                </>
              ) : (
                <>
                  {formatCredits(readings.credits)}
                  <em>积分</em>
                </>
              )}
            </div>
            <div className={`credits${withTokens && withCredits ? '' : ' plain'}`}>
              {readings.waterMark ? `${readings.waterMark} · ` : ''}
              {withTokens && withCredits ? `${formatCredits(readings.credits)} 分` : `${readings.calls} 次`}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 应用 */

function FloatApp(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [side, setSide] = useState<FloatCardSide>('up')
  const [alignRight, setAlignRight] = useState(true)
  const [dragging, setDragging] = useState(false)
  const theme = settings?.floatTheme ?? 'auto'
  useCapsuleTheme(theme)
  const readings = useMemo(() => readingsOf(snapshot), [snapshot])

  useEffect(() => {
    if (!meter) return
    try {
      void meter.getSnapshot().then(setSnapshot).catch(() => undefined)
      void meter.getSettings().then(setSettings).catch(() => undefined)
      void meter
        .getFloatState()
        .then((state) => {
          setExpanded(state.expanded)
          setSide(state.side)
          setAlignRight(state.alignRight)
        })
        .catch(() => undefined)
      const offSnapshot = meter.onSnapshot(setSnapshot)
      const offSettings = meter.onSettings(setSettings)
      const offExpanded = meter.onFloatExpanded((state) => {
        setExpanded(state.expanded)
        setSide(state.side)
        setAlignRight(state.alignRight)
      })
      return () => {
        offSnapshot()
        offSettings()
        offExpanded()
      }
    } catch (error) {
      console.error('[capsule] 初始化失败', error)
      return
    }
  }, [])

  // Esc 收卡片。窗口是点开卡片时被系统激活的，所以这时候键盘焦点确实在这儿
  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') meter?.collapseFloatCard()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const cycleTheme = useCallback(() => {
    if (!meter) return
    const next = CAPSULE_THEME_ORDER[(CAPSULE_THEME_ORDER.indexOf(theme) + 1) % CAPSULE_THEME_ORDER.length]
    // 先点亮，主进程落盘 + 广播之后再以它为准校正回来
    setSettings((current) => (current ? { ...current, floatTheme: next } : current))
    void meter.updateSettings({ floatTheme: next }).then(setSettings).catch(() => undefined)
  }, [theme])

  const solid = settings?.floatSolidBackground ?? false
  const capsuleSize = CAPSULE_SIZES[settings?.floatSize ?? 'medium']

  return (
    <div
      className={`float-stack${solid ? ' solid' : ''}`}
      data-side={side}
      style={{
        alignItems: alignRight ? 'flex-end' : 'flex-start',
        // 缝的宽度必须等于主进程算窗口高度用的 CARD_GAP
        gap: expanded ? `${CARD_GAP}px` : 0
      }}
    >
      {expanded ? (
        <Card
          snapshot={snapshot}
          readings={readings}
          side={side}
          alignRight={alignRight}
          theme={theme}
          onCycleTheme={cycleTheme}
          onCollapse={() => meter?.collapseFloatCard()}
        />
      ) : null}
      <Capsule
        readings={readings}
        size={capsuleSize}
        expanded={expanded}
        dragging={dragging}
        onDragStateChange={setDragging}
      />
    </div>
  )
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <FloatApp />
    </StrictMode>
  )
}
