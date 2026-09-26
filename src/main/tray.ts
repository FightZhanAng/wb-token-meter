import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import {
  compact,
  contextSummary,
  credits as formatCredits,
  formatClock,
  hasCredits,
  hasQuota,
  percent,
  relativeTime,
  SOURCE_ORDER,
  sourceLabel,
  THEME_ORDER,
  themeLabel
} from '../shared/format'
import { describeReset, quotaSummary, quotaWindowLabel, windowOf } from '../shared/opencode-quota'
import type { FloatSize, Snapshot, SourceKind, ThemeMode } from '../shared/types'
import { trayIconImage } from './paths'

export interface TrayCallbacks {
  onOpenMain(): void
  onRefresh(): void
  onOpenDataDir(): void
  onQuit(): void

  /* 数据源 */
  getSource(): SourceKind
  onSetSource(kind: SourceKind): void

  /* 外观 */
  getTheme(): ThemeMode
  onSetTheme(mode: ThemeMode): void

  /* 桌面胶囊 */
  getFloatEnabled(): boolean
  onToggleFloat(enabled: boolean): void
  getFloatAlwaysOnTop(): boolean
  onToggleFloatAlwaysOnTop(enabled: boolean): void
  getFloatSize(): FloatSize
  onSetFloatSize(size: FloatSize): void
  getFloatOpacity(): number
  onSetFloatOpacity(value: number): void
  getFloatSolid(): boolean
  onToggleFloatSolid(solid: boolean): void
  onResetFloatPosition(): void
}

const SIZE_LABELS: Record<FloatSize, string> = { small: '小', medium: '中', large: '大' }
const SIZE_ORDER: FloatSize[] = ['small', 'medium', 'large']
const OPACITY_OPTIONS = [1, 0.9, 0.8, 0.7, 0.5]

export class TrayController {
  private tray: Tray | null = null
  private menu: Menu | null = null
  private signature = ''

  constructor(private readonly cb: TrayCallbacks) {}

  create(): void {
    this.tray = new Tray(trayIconImage(0))
    this.tray.setToolTip('Token 计量器')
    this.tray.on('click', () => this.cb.onOpenMain())
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu ?? undefined))
  }

  /** 手动刷新后强制重建菜单，让「更新于」立刻反映出来 */
  notifyRefreshed(): void {
    this.signature = ''
  }

  /** 在鼠标当前位置弹出菜单 —— 胶囊上右键时用 */
  popUp(): void {
    if (!this.tray || !this.menu) return
    this.tray.popUpContextMenu(this.menu)
  }

  update(snapshot: Snapshot): void {
    if (!this.tray) return

    const now = Date.now()
    const withCredits = hasCredits(snapshot.kind)
    const withQuota = hasQuota(snapshot.kind)
    const quota = withQuota ? snapshot.quota : undefined
    const todayTokens = snapshot.today.inputTokens + snapshot.today.outputTokens
    const active = snapshot.active
    // 进度环报「占了上限的多少」：额度源用 5 小时窗口，
    // 其余源用活跃会话的上下文水位 —— 那是唯一有明确上限的本地实时指标
    const rolling = quota ? (windowOf(quota.windows, 'rolling') ?? quota.windows[0] ?? null) : null
    const ratio = withQuota
      ? rolling
        ? Math.min(1, rolling.percent / 100)
        : 0
      : active && active.size > 0
        ? Math.min(1, active.used / active.size)
        : 0

    const source = this.cb.getSource()
    const theme = this.cb.getTheme()
    const floatEnabled = this.cb.getFloatEnabled()
    const floatSize = this.cb.getFloatSize()
    const floatOpacity = this.cb.getFloatOpacity()
    const floatOnTop = this.cb.getFloatAlwaysOnTop()
    const floatSolid = this.cb.getFloatSolid()

    // 额度只有三个百分比，值没变就不该重建菜单，所以整套窗口值都得进签名
    const quotaSignature = quota
      ? `${quota.fetchedAt}|${quota.stale ? 1 : 0}|${quota.error ?? ''}|${quota.windows
          .map((win) => `${win.key}:${win.percent}:${win.resetsAt}`)
          .join(',')}`
      : ''

    // 只在可见内容真的变了时才重建菜单，免得每 20 秒白干一次
    const signature = [
      snapshot.kind,
      todayTokens,
      withCredits ? snapshot.today.credits : 0,
      snapshot.totals.sessions,
      Math.round(ratio * 100),
      active?.sessionId ?? '',
      snapshot.generatedAt,
      quotaSignature,
      source,
      theme,
      floatEnabled,
      floatSize,
      floatOpacity.toFixed(2),
      floatOnTop,
      floatSolid
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature

    this.tray.setImage(trayIconImage(ratio))

    // Kimi Code 没有积分，整块收起而不是显示 0 分
    const todayLine = withCredits
      ? `今日 ${compact(todayTokens)} token · ${formatCredits(snapshot.today.credits)} 积分`
      : `今日 ${compact(todayTokens)} token · ${snapshot.today.calls} 次调用`

    const quotaText = `${quotaSummary(quota?.windows ?? [], 'short')}${quota?.stale ? '（旧数据）' : ''}`

    const tooltip = withQuota
      ? ['Token 计量器', sourceLabel(snapshot.kind), quotaText].join(' · ')
      : [
          'Token 计量器',
          `${sourceLabel(snapshot.kind)} · 今日 ${compact(todayTokens)} tok`,
          ...(withCredits ? [`${formatCredits(snapshot.today.credits)} 积分`] : []),
          contextSummary(active)
        ].join(' · ')
    this.tray.setToolTip(tooltip)

    // 额度源没有 token 明细也没有上下文，顶部那两行换成额度水位与重置时间
    const headLines: MenuItemConstructorOptions[] = withQuota
      ? [
          { label: `额度 ${quotaSummary(quota?.windows ?? [], 'short')}`, enabled: false },
          {
            label:
              rolling && rolling.resetsAt
                ? `重置：${resetBrief(rolling.resetsAt, now)}（${quotaWindowLabel(rolling.key)}）`
                : '重置时间未知',
            enabled: false
          },
          ...(quota?.error
            ? [
                {
                  label: `${quota.fetchedAt ? '上次刷新失败' : '额度获取失败'}：${quota.error}`,
                  enabled: false
                } as MenuItemConstructorOptions
              ]
            : [])
        ]
      : [
          { label: todayLine, enabled: false },
          {
            label: active
              ? active.size > 0
                ? `上下文 ${compact(active.used)} / ${compact(active.size)}（${percent(active.used, active.size)}%）`
                : `上下文 ${compact(active.used)} token（模型上限未知）`
              : '当前无活跃会话',
            enabled: false
          },
          ...(withCredits
            ? [
                {
                  label: `比价 1 积分 ≈ ${compact(safeRate(snapshot))} token`,
                  enabled: false
                } as MenuItemConstructorOptions
              ]
            : [])
        ]

    const template: MenuItemConstructorOptions[] = [
      ...headLines,
      { type: 'separator' },
      {
        label: `数据源：${sourceLabel(snapshot.kind)}`,
        submenu: SOURCE_ORDER.map((kind) => ({
          label: sourceLabel(kind),
          type: 'radio' as const,
          checked: source === kind,
          click: () => this.cb.onSetSource(kind)
        }))
      },
      {
        label: `外观：${themeLabel(theme)}`,
        submenu: THEME_ORDER.map((mode) => ({
          label: themeLabel(mode),
          type: 'radio' as const,
          checked: theme === mode,
          click: () => this.cb.onSetTheme(mode)
        }))
      },
      { type: 'separator' },
      { label: '打开面板', click: () => this.cb.onOpenMain() },
      { label: '立即刷新', click: () => this.cb.onRefresh() },
      {
        label: `更新于 ${formatClock(snapshot.generatedAt)}（${relativeTime(snapshot.generatedAt, now)}）`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: '桌面胶囊',
        type: 'checkbox',
        checked: floatEnabled,
        click: (item) => this.cb.onToggleFloat(item.checked)
      },
      {
        label: '胶囊尺寸',
        enabled: floatEnabled,
        submenu: SIZE_ORDER.map((size) => ({
          label: SIZE_LABELS[size],
          type: 'radio' as const,
          checked: floatSize === size,
          click: () => this.cb.onSetFloatSize(size)
        }))
      },
      {
        label: '胶囊不透明度',
        enabled: floatEnabled,
        submenu: OPACITY_OPTIONS.map((value) => ({
          label: `${Math.round(value * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(floatOpacity - value) < 0.01,
          click: () => this.cb.onSetFloatOpacity(value)
        }))
      },
      {
        label: '胶囊始终置顶',
        type: 'checkbox',
        enabled: floatEnabled,
        checked: floatOnTop,
        click: (item) => this.cb.onToggleFloatAlwaysOnTop(item.checked)
      },
      {
        label: '胶囊实心底色',
        type: 'checkbox',
        enabled: floatEnabled,
        checked: floatSolid,
        click: (item) => this.cb.onToggleFloatSolid(item.checked)
      },
      {
        label: '复位胶囊位置',
        enabled: floatEnabled,
        click: () => this.cb.onResetFloatPosition()
      },
      { type: 'separator' },
      { label: '打开数据目录', click: () => this.cb.onOpenDataDir() },
      { label: '退出', click: () => this.cb.onQuit() }
    ]

    this.menu = Menu.buildFromTemplate(template)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}

/** 菜单行前面已经写了「重置：」，而 describeReset 的文案自带「重置」二字，去掉尾缀免得读重 */
function resetBrief(resetsAt: number, now: number): string {
  return describeReset(resetsAt, now).replace(/重置$/, '')
}

/** 全局 token/积分比价；积分太小或无数据时退回 0 */
function safeRate(snapshot: Snapshot): number {
  if (snapshot.totals.credits <= 0) return 0
  return (snapshot.totals.inputTokens + snapshot.totals.outputTokens) / snapshot.totals.credits
}
