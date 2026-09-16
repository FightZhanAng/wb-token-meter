import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { compact, credits as formatCredits, formatClock, percent, relativeTime } from '../shared/format'
import type { FloatSize, Snapshot } from '../shared/types'
import { trayIconImage } from './paths'

export interface TrayCallbacks {
  onOpenMain(): void
  onRefresh(): void
  onOpenDataDir(): void
  onQuit(): void

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

    const todayTokens = snapshot.today.inputTokens + snapshot.today.outputTokens
    const active = snapshot.active
    // 进度环表示当前活跃会话的上下文水位 —— 这是唯一有明确上限的实时指标
    const ratio = active && active.size > 0 ? Math.min(1, active.used / active.size) : 0

    const floatEnabled = this.cb.getFloatEnabled()
    const floatSize = this.cb.getFloatSize()
    const floatOpacity = this.cb.getFloatOpacity()
    const floatOnTop = this.cb.getFloatAlwaysOnTop()
    const floatSolid = this.cb.getFloatSolid()

    // 只在可见内容真的变了时才重建菜单，免得每 20 秒白干一次
    const signature = [
      todayTokens,
      snapshot.today.credits,
      snapshot.totals.sessions,
      Math.round(ratio * 100),
      active?.sessionId ?? '',
      snapshot.generatedAt,
      floatEnabled,
      floatSize,
      floatOpacity.toFixed(2),
      floatOnTop,
      floatSolid
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature

    this.tray.setImage(trayIconImage(ratio))

    const tooltip = [
      'Token 计量器',
      `今日 ${compact(todayTokens)} tok`,
      `${formatCredits(snapshot.today.credits)} 积分`,
      active && active.size > 0 ? `上下文 ${percent(active.used, active.size)}%` : '无活跃会话'
    ].join(' · ')
    this.tray.setToolTip(tooltip)

    const template: MenuItemConstructorOptions[] = [
      { label: `今日 ${compact(todayTokens)} token · ${formatCredits(snapshot.today.credits)} 积分`, enabled: false },
      {
        label: active
          ? `上下文 ${compact(active.used)} / ${compact(active.size)}（${percent(active.used, active.size)}%）`
          : '当前无活跃会话',
        enabled: false
      },
      { label: `比价 1 积分 ≈ ${compact(safeRate(snapshot))} token`, enabled: false },
      { type: 'separator' },
      { label: '打开面板', click: () => this.cb.onOpenMain() },
      { label: '立即刷新', click: () => this.cb.onRefresh() },
      {
        label: `更新于 ${formatClock(snapshot.generatedAt)}（${relativeTime(snapshot.generatedAt, Date.now())}）`,
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

/** 全局 token/积分比价；积分太小或无数据时退回 0 */
function safeRate(snapshot: Snapshot): number {
  if (snapshot.totals.credits <= 0) return 0
  return (snapshot.totals.inputTokens + snapshot.totals.outputTokens) / snapshot.totals.credits
}
