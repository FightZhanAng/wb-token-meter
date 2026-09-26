import { BrowserWindow, nativeTheme, screen } from 'electron'
import { windowSizeOf } from '../shared/layout'
import type { FloatPosition, FloatState, Settings } from '../shared/types'
import { hardenWindow, loadRenderer } from './paths'

/** 默认摆在右下角时离屏幕边缘的距离 */
const MARGIN = 28
/** showInactive 之后等这么久还不可见，就回退到带焦点的 show() */
const VISIBLE_FALLBACK_MS = 700
/** 拖动结束后隔多久落盘一次位置，别让每帧移动都写磁盘 */
const POSITION_FLUSH_MS = 400

/**
 * 「实心底色」模式下窗口自己的底色。透明模式用全透明。
 * 必须和 float.css 的 --sheet 对上（深色 #131E21 / 浅色 #F6F8F5）——
 * 这两个值只在主进程用得到（窗口底色是创建参数，CSS 管不着），
 * 对不上的表现是胶囊四周多出一圈异色。
 */
function capsuleBackground(solid: boolean): string {
  if (!solid) return '#00000000'
  return nativeTheme.shouldUseDarkColors ? '#131E21' : '#F6F8F5'
}

/**
 * 桌面常驻胶囊。
 *
 * 与「弹出式提醒浮窗」的区别：这个是常驻的，不自动隐藏，
 * 拖动改变位置并记住，单击（不是拖动）打开主面板。
 *
 * 三个绕不过去的取舍：
 * 1) `transparent` 是**创建参数**，运行期改不了。想在不透明 / 透明之间切换，
 *    只能销毁重建窗口 —— 好在窗口本来就是按需创建的。
 * 2) 透明窗口不做逐像素命中测试，整块矩形都会挡住下面窗口的点击。
 *    所以胶囊要小（最大档也才 252x68），并且提供不透明降级模式。
 * 3) 拖动与单击必须分开：用 pointer capture 自己实现拖动，
 *    判定「移动距离小于阈值」才算点击。用 CSS 的 -webkit-app-region: drag
 *    会把 click 事件整个吃掉，那样就没法「点击打开面板」了。
 */
export class FloatWindow {
  private win: BrowserWindow | null = null
  private loaded = false
  private readyToShow = false
  private pendingShow = false
  private visibleFallback: NodeJS.Timeout | null = null
  private readyTimeout: NodeJS.Timeout | null = null
  private positionTimer: NodeJS.Timeout | null = null
  /** 创建时用的底色模式，用来判断是否需要重建窗口 */
  private createdSolid: boolean | null = null

  constructor(
    private readonly preload: string,
    private readonly readSettings: () => Settings,
    private readonly onMoved: (position: FloatPosition) => void
  ) {}

  get browserWindow(): BrowserWindow | null {
    return this.win
  }

  /** 供自检回报，别让它变成黑盒 */
  describe(): FloatState {
    const win = this.win
    if (!win || win.isDestroyed()) {
      return { created: false, visible: false, loaded: false, bounds: null }
    }
    return {
      created: true,
      visible: win.isVisible(),
      loaded: this.loaded,
      bounds: win.getBounds()
    }
  }

  ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const settings = this.readSettings()
    const solid = settings.floatSolidBackground
    const { width, height } = windowSizeOf(settings.floatSize)

    const win = new BrowserWindow({
      width,
      height,
      frame: false,
      // 不透明模式是「透明窗口在当前环境不可见」时的逃生通道
      transparent: !solid,
      backgroundColor: capsuleBackground(solid),
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
        nodeIntegration: false
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

    win.on('closed', () => {
      this.win = null
      this.loaded = false
      this.readyToShow = false
      this.pendingShow = false
      this.createdSolid = null
    })

    loadRenderer(win, 'float')
    this.win = win
    this.createdSolid = solid
    this.place(win)
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
    if (this.win && !this.win.isDestroyed()) this.win.hide()
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

    const { width, height } = windowSizeOf(settings.floatSize)
    const bounds = win.getBounds()
    if (bounds.width !== width || bounds.height !== height) {
      win.setBounds({ x: bounds.x, y: bounds.y, width, height })
    }
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
    win.setBackgroundColor(capsuleBackground(true))
  }

  /**
   * 把胶囊挪到 (x, y)，尺寸按当前设置写死。
   *
   * 不能用 setPosition：它内部是「读回当前尺寸再写回」，Win11（150% 缩放）上每调用
   * 一次窗口就宽高各 +1（复现数据：222x81 连续 100 次后变成 322x181），拖拽时
   * pointermove 一秒钟几十帧，几秒就把胶囊撑大。显式 setBounds 固定尺寸则完全稳定。
   */
  private moveTo(x: number, y: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const { width, height } = windowSizeOf(this.readSettings().floatSize)
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
  }

  /** 拖动窗口：由渲染层送来增量位移 */
  moveBy(dx: number, dy: number): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    this.moveTo(x + dx, y + dy)

    if (this.positionTimer) clearTimeout(this.positionTimer)
    this.positionTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const [px, py] = win.getPosition()
      this.onMoved({ x: px, y: py })
    }, POSITION_FLUSH_MS)
  }

  /** 把胶囊放回默认的右下角 */
  resetPosition(): void {
    const win = this.ensure()
    const { workArea } = screen.getPrimaryDisplay()
    const { width, height } = windowSizeOf(this.readSettings().floatSize)
    this.moveTo(
      workArea.x + workArea.width - width - MARGIN,
      workArea.y + workArea.height - height - MARGIN
    )
    const [px, py] = win.getPosition()
    this.onMoved({ x: px, y: py })
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
    this.visibleFallback = null
    this.readyTimeout = null
    this.positionTimer = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.loaded = false
    this.readyToShow = false
    this.pendingShow = false
    this.createdSolid = null
  }

  private present(win: BrowserWindow): void {
    const settings = this.readSettings()
    win.setAlwaysOnTop(settings.floatAlwaysOnTop, 'floating')
    win.setOpacity(clampOpacity(settings.floatOpacity))
    // 刻意用 showInactive：胶囊弹出来把正在打字的焦点抢走是这类工具最招人烦的行为
    win.showInactive()

    if (this.visibleFallback) clearTimeout(this.visibleFallback)
    this.visibleFallback = setTimeout(() => {
      if (win.isDestroyed() || win.isVisible()) return
      // 透明窗口在部分环境 showInactive 后不可见，回退到带焦点的 show()
      win.show()
    }, VISIBLE_FALLBACK_MS)
  }

  /** 优先用记住的位置，但要在屏幕还是接着的才用 */
  private place(win: BrowserWindow): void {
    const saved = this.readSettings().floatPosition
    if (saved && this.isReachable(win, saved)) {
      this.moveTo(saved.x, saved.y)
      return
    }
    const { workArea } = screen.getPrimaryDisplay()
    const { width, height } = windowSizeOf(this.readSettings().floatSize)
    this.moveTo(
      workArea.x + workArea.width - width - MARGIN,
      workArea.y + workArea.height - height - MARGIN
    )
  }

  /** 拔掉外接显示器后，别把胶囊恢复到看不见的地方去 */
  private isReachable(win: BrowserWindow, position: FloatPosition): boolean {
    const { width, height } = win.getBounds()
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea
      const overlapX = Math.min(position.x + width, area.x + area.width) - Math.max(position.x, area.x)
      const overlapY = Math.min(position.y + height, area.y + area.height) - Math.max(position.y, area.y)
      return overlapX > 60 && overlapY > 30
    })
  }
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0.3, value))
}
