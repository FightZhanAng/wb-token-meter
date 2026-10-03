import { BrowserWindow, nativeTheme, screen } from 'electron'
import { capsuleSolidBackground } from '../shared/capsule'
import {
  CAPSULE_SIZES,
  defaultCapsulePosition,
  floatWindowBounds,
  type Box,
  type Point
} from '../shared/layout'
import type { FloatCardSide, FloatPosition, FloatState, Settings } from '../shared/types'
import { hardenWindow, loadRenderer } from './paths'

/** 默认摆在右下角时离屏幕边缘的距离 */
const MARGIN = 28
/** showInactive 之后等这么久还不可见，就回退到带焦点的 show() */
const VISIBLE_FALLBACK_MS = 700
/** 拖动结束后隔多久落盘一次位置，别让每帧移动都写磁盘 */
const POSITION_FLUSH_MS = 400
/** 收起握手：等渲染层画完的兜底时限，超时照样缩窗 */
const PENDING_COLLAPSE_MS = 200

/**
 * 实心底色模式下窗口自己的底色。
 * 透明模式用全透明；不透明模式必须和 float.css 里同名主题的 --sheet 对上
 * —— 对不上的表现是胶囊四周多出一圈异色（见 shared/capsule.ts 的表）。
 */
function capsuleBackground(settings: Settings): string {
  if (!settings.floatSolidBackground) return '#00000000'
  return capsuleSolidBackground(settings.floatTheme, nativeTheme.shouldUseDarkColors)
}

/**
 * 桌面常驻胶囊。
 *
 * 与「弹出式提醒浮窗」的区别：这个是常驻的，不自动隐藏，拖动改变位置并记住。
 * **单击展开一张信息更丰富的悬浮卡片**，卡片里的「打开面板」才进主窗口 ——
 * 胶囊上那一点点面积放不下多少东西，把所有细节都塞进面板等于每次只想知道
 * 一个数字都要开一次窗口。
 *
 * 四个绕不过去的取舍：
 * 1) `transparent` 是**创建参数**，运行期改不了。想在不透明 / 透明之间切换，
 *    只能销毁重建窗口 —— 好在窗口本来就是按需创建的。
 * 2) 透明窗口不做逐像素命中测试，整块矩形都会挡住下面窗口的点击。
 *    所以胶囊要小（最大档也才 252x68），并且提供不透明降级模式；
 *    展开的卡片也只在点开的那几秒里存在。
 * 3) 拖动与单击必须分开：用 pointer capture 自己实现拖动，
 *    判定「移动距离小于阈值」才算点击。用 CSS 的 -webkit-app-region: drag
 *    会把 click 事件整个吃掉，那样就没法「点击展开卡片」了。
 * 4) 展开**不新建窗口**，只是把同一个窗口撑大，并让胶囊在里面原地不动。
 *    窗口位置由「胶囊在屏幕上的位置」(origin) 反推，收起/展开共用一套算法，
 *    所以来回切是幂等的，不会一格一格地漂。
 */
export class FloatWindow {
  private win: BrowserWindow | null = null
  private loaded = false
  private readyToShow = false
  private pendingShow = false
  private visibleFallback: NodeJS.Timeout | null = null
  private readyTimeout: NodeJS.Timeout | null = null
  private positionTimer: NodeJS.Timeout | null = null
  /** 收起握手：渲染层画完前挂起的缩窗动作 */
  private pendingCollapse: NodeJS.Timeout | null = null
  /** 上一次套上的 region（去重，拖拽时别每帧都发 SetWindowRgn） */
  private appliedShape: string | null = null
  /** 上一次发给系统的窗口几何，几何没变就不再 SetWindowPos（见 applyPlacement） */
  private appliedBounds: string | null = null
  /**
   * 方向是否已经定下来。首次落位时按胶囊位置现算并定给渲染层，之后收起
   * 一律沿用 —— 渲染层没重排之前主进程不能自己翻边。
   */
  private anchorReady = false
  /** 创建时用的底色模式，用来判断是否需要重建窗口 */
  private createdSolid: boolean | null = null

  /**
   * 胶囊在屏幕上的位置（左上角）—— **唯一真相**。
   * 窗口摆在哪儿是它算出来的；窗口被贴边收紧后，结果又写回这里。
   */
  private origin: Point | null = null
  private expanded = false
  private side: FloatCardSide = 'up'
  /** 胶囊贴窗口哪一侧。渲染层要它才能把卡片和胶囊对齐，所以得算一处、报一处 */
  private alignRight = true

  constructor(
    private readonly preload: string,
    private readonly readSettings: () => Settings,
    private readonly onMoved: (position: FloatPosition) => void
  ) {}

  get browserWindow(): BrowserWindow | null {
    return this.win
  }

  get isExpanded(): boolean {
    return this.expanded
  }

  /** 供自检回报，别让它变成黑盒 */
  describe(): FloatState {
    const win = this.win
    if (!win || win.isDestroyed()) {
      return {
        created: false,
        visible: false,
        loaded: false,
        expanded: this.expanded,
        side: this.side,
        alignRight: this.alignRight,
        capsule: null,
        bounds: null
      }
    }
    return {
      created: true,
      visible: win.isVisible(),
      loaded: this.loaded,
      expanded: this.expanded,
      side: this.side,
      alignRight: this.alignRight,
      capsule: this.origin,
      bounds: win.getBounds()
    }
  }

  ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const settings = this.readSettings()
    const solid = settings.floatSolidBackground

    const win = new BrowserWindow({
      frame: false,
      // 不透明模式是「透明窗口在当前环境不可见」时的逃生通道
      transparent: !solid,
      backgroundColor: capsuleBackground(settings),
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.floatAlwaysOnTop,
      show: false,
      hasShadow: solid,
      title: 'Token 计量器',
      webPreferences: {
        preload: this.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        /*
         * 胶囊主题不能靠页面自己去问 —— 问一轮 IPC 回来时首帧早就画完了，
         * 浅色的那一帧会先闪一下（胶囊是不透明小窗，闪一下特别明显）。
         * 用启动参数把它带进渲染进程，preload 在样式表之前就能落到 <html> 上。
         */
        additionalArguments: [`--wbm-capsule-theme=${settings.floatTheme}`]
      }
    })

    hardenWindow(win)
    win.setAlwaysOnTop(settings.floatAlwaysOnTop, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    win.setOpacity(clampOpacity(settings.floatOpacity))

    win.once('ready-to-show', () => {
      this.readyToShow = true
      if (this.pendingShow) {
        this.pendingShow = false
        this.present(win)
      }
    })

    win.webContents.on('did-finish-load', () => {
      this.loaded = true
    })
    win.webContents.on('did-fail-load', (_event, code, description) => {
      // 透明窗口加载失败的表现和「根本没显示」一模一样，留个记录
      console.error(`[float] did-fail-load code=${code} ${description}`)
    })

    /*
     * 点开卡片之后点到别处就收起来 —— 这是「悬浮卡片」该有的手感，
     * 也是唯一不需要用户去够关闭按钮的收起方式。
     * 只认焦点的丢失：胶囊本身是 showInactive 弹出来的，没焦点可丢，
     * 所以这条不会在它刚出现时误触发。
     */
    win.on('blur', () => {
      if (this.expanded) this.setExpanded(false)
    })

    win.on('closed', () => {
      this.win = null
      this.loaded = false
      this.readyToShow = false
      this.pendingShow = false
      this.createdSolid = null
      if (this.pendingCollapse) clearTimeout(this.pendingCollapse)
      this.pendingCollapse = null
      this.appliedShape = null
      this.appliedBounds = null
    })

    loadRenderer(win, 'float')
    this.win = win
    this.createdSolid = solid

    // 位置：优先用记住的胶囊位置，但它得还在某块屏幕上
    const saved = settings.floatPosition
    this.origin = saved && this.isReachable(saved) ? saved : null
    this.applyPlacement()
    return win
  }

  show(): void {
    const win = this.ensure()
    if (this.readyToShow) {
      this.present(win)
      return
    }
    this.pendingShow = true
    // ready-to-show 万一一直不来，也不能让胶囊永远不出现
    if (this.readyTimeout) clearTimeout(this.readyTimeout)
    this.readyTimeout = setTimeout(() => {
      if (win.isDestroyed() || !this.pendingShow) return
      this.pendingShow = false
      this.present(win)
    }, 1500)
  }

  hide(): void {
    // 藏起来之前先收起卡片：下次露面时总该是那个干净的小胶囊
    this.setExpanded(false)
    if (this.win && !this.win.isDestroyed()) this.win.hide()
    // 窗口都藏了就没有闪烁可言，别让挂起的缩窗等到超时
    this.settleCollapse()
  }

  /** 返回切换后是否可见 */
  toggle(): boolean {
    const win = this.ensure()
    if (win.isVisible()) {
      win.hide()
      return false
    }
    this.show()
    return true
  }

  /**
   * 展开 / 收起卡片。胶囊在屏幕上的位置不变 —— 视觉上是卡片从胶囊旁边长出来，
   * 而不是胶囊跳到了别处。
   *
   * 两个模式、两条时序：
   * - **形状模式（透明窗口）**：窗口恒为展开尺寸，收起/展开只换 region 与内容。
   *   region（SetWindowRgn）的裁剪即时生效，纹理不变就没有 DWM 重锚问题。
   *   关键是**两态的窗口 bounds 完全相同**（见 floatWindowBounds），所以这里
   *   摆窗口时几何没变就不发 SetWindowPos —— 发了就等于让 DWM 白重锚一次。
   * - **solid 降级模式**：窗口真的在缩放。收起必须「先让渲染层拆卡片，画完一帧
   *   （float:content-settled 回报）再缩窗」—— 反过来先缩窗的话，窗口已经变成
   *   胶囊大小、内容还是整张卡片，被硬切一刀，表现就是收起时闪一下。
   *   窗口不可见时没有闪烁可言，直接摆。
   */
  setExpanded(next: boolean): void {
    if (this.expanded === next) return
    const before = this.origin
    this.expanded = next
    const win = this.win
    const solid = this.readSettings().floatSolidBackground
    const defer = !next && solid && !!win && !win.isDestroyed() && win.isVisible()
    if (defer) {
      this.send('float:expanded', { expanded: this.expanded, side: this.side, alignRight: this.alignRight })
      // 渲染层挂了 / 还没加载时 ack 永远不来 —— 到点还是得缩，别把大窗留着
      if (this.pendingCollapse) clearTimeout(this.pendingCollapse)
      this.pendingCollapse = setTimeout(() => this.settleCollapse(), PENDING_COLLAPSE_MS)
      return
    }
    const { capsule } = this.applyPlacement()
    this.send('float:expanded', { expanded: this.expanded, side: this.side, alignRight: this.alignRight })
    // 只有贴边收紧真的把胶囊挪动了才落盘 —— 正常情况下展开不动胶囊，不必写盘
    if (before && (before.x !== capsule.x || before.y !== capsule.y)) {
      this.onMoved({ x: capsule.x, y: capsule.y })
    }
  }

  /** 渲染层：收起后的内容已经画完并呈现了一帧。这时缩窗正好是无感的 */
  contentSettled(): void {
    this.settleCollapse()
  }

  private settleCollapse(): void {
    if (!this.pendingCollapse) return
    clearTimeout(this.pendingCollapse)
    this.pendingCollapse = null
    const before = this.origin
    const { capsule } = this.applyPlacement()
    if (before && (before.x !== capsule.x || before.y !== capsule.y)) {
      this.onMoved({ x: capsule.x, y: capsule.y })
    }
  }

  toggleExpand(): boolean {
    const win = this.ensure()
    if (!win.isVisible()) this.show()
    this.setExpanded(!this.expanded)
    return this.expanded
  }

  /**
   * 设置变更后同步到窗口。
   * 底色模式变了要重建（transparent 改不了），其余就地应用。
   */
  syncFromSettings(): void {
    const settings = this.readSettings()
    if (this.win && !this.win.isDestroyed() && this.createdSolid !== settings.floatSolidBackground) {
      const wasVisible = this.win.isVisible()
      this.destroy()
      if (wasVisible) this.show()
      return
    }
    const win = this.win
    if (!win || win.isDestroyed()) return

    // 尺寸档位变了要重算窗口（展开态下卡片也跟着换），位置由 origin 推
    this.applyPlacement()
    win.setAlwaysOnTop(settings.floatAlwaysOnTop, 'floating')
    win.setOpacity(clampOpacity(settings.floatOpacity))
  }

  /**
   * 外观变了：只有「实心底色」模式需要动 —— 透明窗口的底色本来就是全透明，
   * 胶囊本体由 CSS 画。窗口底色可以在运行期改，不必重建。
   */
  syncTheme(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (!this.readSettings().floatSolidBackground) return
    win.setBackgroundColor(capsuleBackground(this.readSettings()))
  }

  /** 拖动窗口：由渲染层送来增量位移。位移作用在**胶囊**上，窗口位置再推出来 */
  moveBy(dx: number, dy: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const origin = this.origin ?? { x: 0, y: 0 }
    this.origin = { x: origin.x + dx, y: origin.y + dy }
    this.applyPlacement()

    if (this.positionTimer) clearTimeout(this.positionTimer)
    this.positionTimer = setTimeout(() => {
      if (win.isDestroyed() || !this.origin) return
      this.onMoved({ x: Math.round(this.origin.x), y: Math.round(this.origin.y) })
    }, POSITION_FLUSH_MS)
  }

  /** 把胶囊放回默认的右下角 */
  resetPosition(): void {
    const win = this.ensure()
    this.origin = null
    const { capsule } = this.applyPlacement()
    if (!win.isDestroyed()) this.onMoved({ x: capsule.x, y: capsule.y })
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed() && this.loaded) {
      this.win.webContents.send(channel, ...args)
    }
  }

  destroy(): void {
    if (this.visibleFallback) clearTimeout(this.visibleFallback)
    if (this.readyTimeout) clearTimeout(this.readyTimeout)
    if (this.positionTimer) clearTimeout(this.positionTimer)
    if (this.pendingCollapse) clearTimeout(this.pendingCollapse)
    this.visibleFallback = null
    this.readyTimeout = null
    this.positionTimer = null
    this.pendingCollapse = null
    this.appliedShape = null
    this.appliedBounds = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.loaded = false
    this.readyToShow = false
    this.pendingShow = false
    this.createdSolid = null
  }

  /**
   * 按 origin 与当前展开状态把窗口摆好，并把（可能被贴边收紧过的）结果写回 origin。
   * 返回胶囊的最终落点，调用方拿它决定要不要落盘。
   */
  private applyPlacement(): { capsule: Point; side: FloatCardSide } {
    const settings = this.readSettings()
    const workArea = this.workArea()
    const origin = this.origin ?? defaultCapsulePosition(settings.floatSize, workArea, MARGIN)
    // 透明窗口走形状模式：窗口恒为展开尺寸，收起态用 region 裁剪。
    // solid 降级模式是「透明不可见」时的逃生通道，窗口本来就小，走原来的 resize。
    const shapeMode = !settings.floatSolidBackground
    const placement = floatWindowBounds({
      size: settings.floatSize,
      capsule: origin,
      expanded: this.expanded,
      workArea,
      shapeMode,
      /*
       * 收起时把当前方向原样传下去，而不是让布局函数按位置重算：
       * 渲染层的 data-side / align-items 要等 float:expanded 到货才改，
       * 主进程先翻边的话 region 会罩在卡片上 —— 闪的就是那块地方。
       */
      frozen:
        shapeMode && !this.expanded && this.anchorReady
          ? { side: this.side, alignRight: this.alignRight }
          : null
    })

    this.origin = placement.capsule
    this.side = placement.side
    this.alignRight = placement.alignRight
    this.anchorReady = true

    const win = this.win
    if (win && !win.isDestroyed()) {
      /*
       * 不能用 setPosition：它内部是「读回当前尺寸再写回」，Win11（150% 缩放）上每调用
       * 一次窗口就宽高各 +1（复现数据：222x81 连续 100 次后变成 322x181），拖拽时
       * pointermove 一秒钟几十帧，几秒就把胶囊撑大。显式 setBounds 固定尺寸则完全稳定。
       *
       * 几何一模一样时**一个调用都不发**：形状模式下收起只该换 region，
       * 多一次 SetWindowPos 就等于让 DWM 白重锚一次纹理 —— 那正是「收起时闪一下」
       * 的来源（屏幕上闪出来的是内容还停在展开态的那块旧纹理）。
       */
      const boundsKey = `${placement.bounds.x},${placement.bounds.y},${placement.bounds.width},${placement.bounds.height}`
      if (boundsKey !== this.appliedBounds) {
        this.appliedBounds = boundsKey
        win.setBounds(placement.bounds)
      }
      if (shapeMode) {
        // region 没变就不重设 —— 拖拽时每帧 setShape 是无谓的系统调用
        const key = JSON.stringify(placement.shape)
        if (key !== this.appliedShape) {
          this.appliedShape = key
          win.setShape(placement.shape ?? [])
        }
      }
    }
    return { capsule: placement.capsule, side: placement.side }
  }

  /** 胶囊在哪块屏幕上，窗口就按哪块屏幕算边界（拖到副屏也要能贴边） */
  private workArea(): Box {
    const point = this.origin ?? { x: 0, y: 0 }
    return screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea
  }

  /** 拔掉外接显示器后，别把胶囊恢复到看不见的地方去 */
  private isReachable(position: Point): boolean {
    const { width, height } = CAPSULE_SIZES[this.readSettings().floatSize]
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea
      const overlapX = Math.min(position.x + width, area.x + area.width) - Math.max(position.x, area.x)
      const overlapY = Math.min(position.y + height, area.y + area.height) - Math.max(position.y, area.y)
      return overlapX > 60 && overlapY > 30
    })
  }

  private present(win: BrowserWindow): void {
    const settings = this.readSettings()
    // 刻意用 showInactive：胶囊弹出来把正在打字的焦点抢走是这类工具最招人烦的行为
    win.showInactive()
    // 置顶必须落在**可见之后**：透明窗口 show 时 DWM 会重建表面，隐藏态设的
    // topmost 会被丢掉 —— 表现是启动后胶囊压不住别的窗口，而 isAlwaysOnTop()
    // 读的是内部标志照样返回 true，自检看着一直是绿的。开关走的 syncFromSettings
    // 是在可见态设的，所以那条路从没暴露过这个坑。
    win.setAlwaysOnTop(settings.floatAlwaysOnTop, 'floating')
    win.setOpacity(clampOpacity(settings.floatOpacity))

    if (this.visibleFallback) clearTimeout(this.visibleFallback)
    this.visibleFallback = setTimeout(() => {
      if (win.isDestroyed() || win.isVisible()) return
      // 透明窗口在部分环境 showInactive 后不可见，回退到带焦点的 show()
      win.show()
      // 这次 show 之前窗口仍不可见，topmost 还会再丢一次 —— 同一个坑补第二刀
      win.setAlwaysOnTop(this.readSettings().floatAlwaysOnTop, 'floating')
    }, VISIBLE_FALLBACK_MS)
  }
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0.3, value))
}
