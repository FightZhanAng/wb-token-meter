import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { CAPSULE_THEME_ORDER, capsuleThemeLabel } from '../shared/capsule'
import {
  compact,
  contextSummary,
  credits as formatCredits,
  formatClock,
  hasCredits,
  hasQuota,
  hasTokens,
  percent,
  relativeTime,
  SOURCE_ORDER,
  sourceLabel,
  THEME_ORDER,
  themeLabel
} from '../shared/format'
import { describeReset, quotaSummary, quotaWindowLabel, windowOf } from '../shared/opencode-quota'
import type { CapsuleTheme, FloatSize, Snapshot, SourceKind, ThemeMode, UpdateState } from '../shared/types'
import { updateStatusText } from '../shared/update'
import { trayIconImage } from './paths'

/** 自检用：一个子菜单的「标题档位」与「被勾中的那一项」 */
export interface MenuChoice {
  label: string
  checked: string
}

export interface TrayCallbacks {
  onOpenMain(): void
  onRefresh(): void
  onOpenDataDir(): void
  onQuit(): void

  /* 版本与更新 */
  getUpdate(): UpdateState
  onCheckUpdate(): void
  onDownloadUpdate(): void
  onInstallUpdate(): void
  onOpenReleasePage(): void

  /* 数据源 */
  getSource(): SourceKind
  onSetSource(kind: SourceKind): void

  /* 外观 */
  getTheme(): ThemeMode
  onSetTheme(mode: ThemeMode): void

  /* 桌面胶囊 */
  getFloatEnabled(): boolean
  onToggleFloat(enabled: boolean): void
  getFloatTheme(): CapsuleTheme
  onSetFloatTheme(theme: CapsuleTheme): void
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

/**
 * 档位表里必须含当前值，否则那一列圆点**一个都不亮** —— 默认的 0.94 就不在这张表里。
 * 不在表里就把它插进「从大到小」的位置，而不是把 0.94 写死进档位表：写死只救得了
 * 这一个值，插进去对所有值都成立（设置文件被手改过也一样）。
 */
function opacityOptions(current: number): number[] {
  if (OPACITY_OPTIONS.some((value) => Math.abs(value - current) < 0.01)) return OPACITY_OPTIONS
  return [...OPACITY_OPTIONS, current].sort((a, b) => b - a)
}

export class TrayController {
  private tray: Tray | null = null
  private menu: Menu | null = null
  /** 最近一份快照 —— refresh() 要靠它重建，等不起下一次轮询 */
  private last: Snapshot | null = null
  private signature = ''

  constructor(private readonly cb: TrayCallbacks) {}

  create(): void {
    this.tray = new Tray(trayIconImage(0))
    this.tray.setToolTip('Token 计量器')
    this.tray.on('click', () => this.cb.onOpenMain())
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.menu ?? undefined))
  }

  /**
   * 立刻用最近一份快照重建菜单。
   *
   * **光清签名是不够的。** 设置类改动（胶囊主题 / 外观 / 数据源…）一个数据字段都不动，
   * 只改菜单标题和勾选态，而下一份快照最多要等 20 秒；更要命的是子菜单里那些
   * `type: 'radio'` 的圆点是**系统自己挪的** —— 点完立刻再打开，圆点已经在新档位上、
   * 标题还停在旧档位，同一条菜单里两个说法打架，看起来就是「选中项对不上」。
   */
  refresh(): void {
    if (!this.last) return
    this.signature = ''
    this.update(this.last)
  }

  /**
   * 自检用：把菜单里那几个「标题带着当前档位」的子菜单报出来。
   *
   * 标题里 `：` 后面那一段必须等于子菜单里被勾中的那一项 —— 这两样分开来各自
   * 都「看着对」，只有它们打架才说明菜单落后于设置，而那正好是要盯的东西。
   */
  describeChoices(): MenuChoice[] {
    const choices: MenuChoice[] = []
    for (const item of this.menu?.items ?? []) {
      if (!item.submenu) continue
      const picked = item.submenu.items.find((entry) => entry.checked)
      choices.push({ label: item.label, checked: picked?.label ?? '' })
    }
    return choices
  }

  /** 在鼠标当前位置弹出菜单 —— 胶囊上右键时用 */
  popUp(): void {
    if (!this.tray || !this.menu) return
    this.tray.popUpContextMenu(this.menu)
  }

  update(snapshot: Snapshot): void {
    // 先存下来：菜单没建出来（托盘还没就绪）也得留着给 refresh() 用
    this.last = snapshot
    if (!this.tray) return

    const now = Date.now()
    const withCredits = hasCredits(snapshot.kind)
    const withTokens = hasTokens(snapshot.kind)
    const withQuota = hasQuota(snapshot.kind)
    const quota = withQuota ? snapshot.quota : undefined
    const todayTokens = snapshot.today.inputTokens + snapshot.today.outputTokens
    const active = snapshot.active
    // 进度环报「占了上限的多少」：额度源用 5 小时窗口，Qoder CN 用会话快照
    // 自带的水位比例，其余源用活跃会话的上下文水位 —— 那是有明确上限的本地指标
    const rolling = quota ? (windowOf(quota.windows, 'rolling') ?? quota.windows[0] ?? null) : null
    const ratio = withQuota
      ? rolling
        ? Math.min(1, rolling.percent / 100)
        : 0
      : active
        ? active.size > 0
          ? Math.min(1, active.used / active.size)
          : (active.ratio ?? 0)
        : 0

    const source = this.cb.getSource()
    const theme = this.cb.getTheme()
    const update = this.cb.getUpdate()
    const floatEnabled = this.cb.getFloatEnabled()
    const floatTheme = this.cb.getFloatTheme()
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

    /*
     * 签名里含 generatedAt，而菜单上印着「更新于 21:52（刚刚）」—— 相对时间每轮都得
     * 跟着走，所以它挡不住轮询本身（每 20 秒确实会重建一次）。它挡的是**同一份快照
     * 被重复喂进来**：设置变更、更新状态变化这些路径都拿最近那份快照重建，没有它就会
     * 连着重来好几遍。
     */
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
      `${update.status}:${update.current}:${update.latest}:${Math.round(update.percent)}`,
      floatEnabled,
      floatTheme,
      floatSize,
      floatOpacity.toFixed(2),
      floatOnTop,
      floatSolid
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature

    this.tray.setImage(trayIconImage(ratio))

    // Qoder CN 没有 token，那一行换成积分；其余源照旧
    const todayLine = !withTokens
      ? `今日 ${formatCredits(snapshot.today.credits)} 积分 · ${snapshot.today.calls} 次调用`
      : withCredits
        ? `今日 ${compact(todayTokens)} token · ${formatCredits(snapshot.today.credits)} 积分`
        : `今日 ${compact(todayTokens)} token · ${snapshot.today.calls} 次调用`

    const quotaText = `${quotaSummary(quota?.windows ?? [], 'short')}${quota?.stale ? '（旧数据）' : ''}`

    const tooltip = withQuota
      ? ['Token 计量器', sourceLabel(snapshot.kind), quotaText].join(' · ')
      : [
          'Token 计量器',
          withTokens
            ? `${sourceLabel(snapshot.kind)} · 今日 ${compact(todayTokens)} tok`
            : `${sourceLabel(snapshot.kind)} · 今日 ${formatCredits(snapshot.today.credits)} 积分`,
          ...(withTokens && withCredits ? [`${formatCredits(snapshot.today.credits)} 积分`] : []),
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
                : active.ratio != null
                  ? `上下文 ${Math.round(active.ratio * 100)}%`
                  : `上下文 ${compact(active.used)} token（模型上限未知）`
              : '当前无活跃会话',
            enabled: false
          },
          // 比价要有 token 才算得出来 —— Qoder CN 只有积分，这一行收起
          ...(withCredits && withTokens
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
      { label: `版本 ${update.current || '未知'}`, enabled: false },
      ...updateActionItems(update, this.cb),
      { type: 'separator' },
      {
        label: '桌面胶囊',
        type: 'checkbox',
        checked: floatEnabled,
        click: (item) => this.cb.onToggleFloat(item.checked)
      },
      /*
       * 胶囊主题不跟面板走 —— 面板只有三档（跟随系统 / 浅色 / 深色），
       * 而贴在桌面上的那块牌子本身就有好几个风格可挑，所以单开一项。
       * 菜单标题带当前档位：这个子菜单里点一下之后菜单就没了，
       * 不带就得再展开一次才知道自己现在在哪一档。
       */
      {
        label: `胶囊主题：${capsuleThemeLabel(floatTheme)}`,
        enabled: floatEnabled,
        submenu: CAPSULE_THEME_ORDER.map((theme) => ({
          label: capsuleThemeLabel(theme),
          type: 'radio' as const,
          checked: floatTheme === theme,
          click: () => this.cb.onSetFloatTheme(theme)
        }))
      },
      /* 尺寸与不透明度也照上面三项的规矩，标题里带上当前档位 —— 子菜单点一下就没了，
         不带就得再展开一次才知道自己现在在哪一档 */
      {
        label: `胶囊尺寸：${SIZE_LABELS[floatSize]}`,
        enabled: floatEnabled,
        submenu: SIZE_ORDER.map((size) => ({
          label: SIZE_LABELS[size],
          type: 'radio' as const,
          checked: floatSize === size,
          click: () => this.cb.onSetFloatSize(size)
        }))
      },
      {
        label: `胶囊不透明度：${Math.round(floatOpacity * 100)}%`,
        enabled: floatEnabled,
        submenu: opacityOptions(floatOpacity).map((value) => ({
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

/**
 * 版本号下面那几行。状态自己会说话，所以只给「现在能做什么」——
 * 没有新版本时给「检查更新」，有新版本时给下载/发布页，下完了给安装。
 */
function updateActionItems(update: UpdateState, cb: TrayCallbacks): MenuItemConstructorOptions[] {
  const openPage: MenuItemConstructorOptions = {
    label: '打开发布页',
    click: () => cb.onOpenReleasePage()
  }
  const recheck: MenuItemConstructorOptions = {
    label: '检查更新',
    click: () => cb.onCheckUpdate()
  }

  switch (update.status) {
    case 'unsupported':
      return [{ label: updateStatusText(update), enabled: false }, openPage]
    case 'checking':
    case 'downloading':
      return [{ label: updateStatusText(update), enabled: false }]
    case 'available':
      return [
        { label: updateStatusText(update), enabled: false },
        ...(update.canDownload
          ? [{ label: '下载更新', click: () => cb.onDownloadUpdate() } as MenuItemConstructorOptions]
          : []),
        openPage
      ]
    case 'downloaded':
      return [
        { label: `新版本 ${update.latest} 已下载`, enabled: false },
        { label: '重启并安装', click: () => cb.onInstallUpdate() }
      ]
    case 'error':
      return [{ label: updateStatusText(update), enabled: false }, { ...recheck, label: '重新检查' }]
    default:
      return [recheck]
  }
}

/** 全局 token/积分比价；积分太小或无数据时退回 0 */
function safeRate(snapshot: Snapshot): number {
  if (snapshot.totals.credits <= 0) return 0
  return (snapshot.totals.inputTokens + snapshot.totals.outputTokens) / snapshot.totals.credits
}
