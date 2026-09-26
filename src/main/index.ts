import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSnapshot, type ParseCache } from '../shared/collector'
import { collectDshSnapshot, type DshParseCache } from '../shared/dsh-collector'
import { SOURCE_ORDER, sourceLabel } from '../shared/format'
import { collectKimiSnapshot, type KimiParseCache } from '../shared/kimi-collector'
import { collectMimoSnapshot } from '../shared/mimo-collector'
import { collectReasonixSnapshot, type ReasonixParseCache } from '../shared/reasonix-collector'
import { collectZcodeSnapshot } from '../shared/zcode-collector'
import type { FloatState, Settings, Snapshot, SourceKind, ThemeMode } from '../shared/types'
import { FloatWindow } from './float'
import { OpencodeUsage } from './opencode-usage'
import {
  appIconPath,
  dshDir,
  hardenWindow,
  kimiDir,
  loadRenderer,
  mimoCacheDir,
  mimoDataDir,
  opencodeDir,
  preloadPath,
  reasonixDir,
  workbuddyDir,
  zcodeDir
} from './paths'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'
import { TrayController } from './tray'

/* ------------------------------------------------------------ 冒烟自检 */

// 结论写磁盘而不是 console.log —— Windows 上 GUI 进程不挂控制台，
// 只靠 stdout 经常什么都看不到，"跑没跑起来"都判断不了。
const SMOKE = process.env['WB_TOKEN_METER_SMOKE'] === '1'
const SMOKE_EXIT = process.env['WB_TOKEN_METER_SMOKE_EXIT'] === '1'

function smoke(name: string, payload: unknown): void {
  if (!SMOKE) return
  try {
    const dir = join(tmpdir(), 'wbtm-smoke')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 自检失败不该影响主流程 */
  }
}

// 模块最顶层就落一个探针：只有它出现、后续报告缺失，
// 说明是 requestSingleInstanceLock 之后没走通，而不是代码没加载。
smoke('boot', {
  at: Date.now(),
  pid: process.pid,
  electron: process.versions.electron,
  node: process.versions.node
})

/* ------------------------------------------------------------ 常量 */

const APP_ID = app.isPackaged ? 'com.tomcato.wb-token-meter' : 'com.tomcato.wb-token-meter.dev'
const REFRESH_MS = 20_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let floatWindow: FloatWindow | null = null
let settingsStore: SettingsStore | null = null
let isQuitting = false
let snapshot: Snapshot | null = null
/** 各数据源各有一份解析缓存 —— 切换数据源不能把对方的增量缓存冲掉 */
const workbuddyCache: ParseCache = new Map()
const kimiCache: KimiParseCache = new Map()
const reasonixCache: ReasonixParseCache = new Map()
const dshCache: DshParseCache = new Map()

/* ------------------------------------------------------------ 采集 */

/** OpenCode Go 的额度客户端。懒创建：只有真的切到那个源才会实例化、才会去读 auth.json */
let opencodeUsage: OpencodeUsage | null = null

/** 当前数据源的数据根目录（「打开数据目录」与采集都认它） */
function sourceDir(kind: SourceKind): string {
  if (kind === 'kimi') return kimiDir()
  if (kind === 'zcode') return zcodeDir()
  if (kind === 'mimo') return mimoDataDir()
  if (kind === 'reasonix') return reasonixDir()
  if (kind === 'dsh') return dshDir()
  if (kind === 'opencode') return opencodeDir()
  return workbuddyDir()
}

function currentSource(): SourceKind {
  return settingsStore?.settings.source ?? DEFAULT_SETTINGS.source
}

/**
 * 外观走 Electron 的 nativeTheme.themeSource：设成 light / dark 之后，
 * 渲染层的 `prefers-color-scheme` 会跟着变，两个窗口的 CSS 直接生效 ——
 * 不用自己发一套主题消息，也就没有「主进程和页面各记一份」的机会。
 */
function applyTheme(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
}

function currentTheme(): ThemeMode {
  return settingsStore?.settings.theme ?? DEFAULT_SETTINGS.theme
}

/**
 * 窗口底色是**创建参数**，CSS 管不到它，只能主进程给。
 * 这两个值必须和 styles.css 的 --paper 对上（深色 #0E1618 / 浅色 #EDF0EC），
 * 否则窗口冒出来的那一帧会先闪一下另一种颜色。
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0E1618' : '#EDF0EC'
}

function ensureOpencodeUsage(): OpencodeUsage {
  if (!opencodeUsage) {
    opencodeUsage = new OpencodeUsage({
      dir: opencodeDir(),
      historyFile: join(app.getPath('userData'), 'opencode-usage-history.jsonl'),
      endpoint: process.env['WB_TOKEN_METER_OPENCODE_URL'],
      keyOverride: process.env['WB_TOKEN_METER_OPENCODE_KEY']
    })
  }
  return opencodeUsage
}

/**
 * 额度源的快照：token 维度全部留空，只带 quota。
 * 界面认 kind === 'opencode' 就整块换成额度视图，这些 0 不会被当成「没数据」。
 */
function buildOpencodeSnapshot(): Snapshot {
  const usage = ensureOpencodeUsage()
  const state = usage.current()
  const empty = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  return {
    kind: 'opencode',
    generatedAt: Date.now(),
    totals: {
      ...empty,
      credits: 0,
      attributedCredits: 0,
      unattributedCredits: 0,
      sessions: 0,
      traces: 0,
      matchedTraces: 0,
      dbTraces: 0
    },
    today: { ...empty, credits: 0 },
    sessions: [],
    days: [],
    models: [],
    projects: [],
    active: null,
    source: { dir: opencodeDir(), files: 0, dbRows: 0 },
    warnings: [],
    quota: {
      windows: state.windows,
      fetchedAt: state.fetchedAt,
      stale: state.stale,
      error: state.error,
      endpoint: usage.endpoint,
      credential: usage.credentialLabel(),
      history: usage.history()
    }
  }
}

function refresh(force = false): Snapshot | null {
  const kind = currentSource()
  try {
    if (kind === 'kimi') {
      snapshot = collectKimiSnapshot({ kimiDir: sourceDir(kind), cache: kimiCache })
    } else if (kind === 'zcode') {
      snapshot = collectZcodeSnapshot({ zcodeDir: sourceDir(kind) })
    } else if (kind === 'mimo') {
      snapshot = collectMimoSnapshot({ mimoDir: sourceDir(kind), cacheDir: mimoCacheDir() })
    } else if (kind === 'reasonix') {
      snapshot = collectReasonixSnapshot({ reasonixDir: sourceDir(kind), cache: reasonixCache })
    } else if (kind === 'dsh') {
      snapshot = collectDshSnapshot({ dshDir: sourceDir(kind), cache: dshCache })
    } else if (kind === 'opencode') {
      snapshot = buildOpencodeSnapshot()
      // 网络请求绝不能挡住 20 秒一次的同步轮询：先把缓存画出来，真拉到了再走一遍广播。
      // pull 自带去重与节流，重入到这里只会拿到 false，不会绕成死循环。
      void ensureOpencodeUsage()
        .pull(force)
        .then((pulled) => {
          if (pulled && currentSource() === 'opencode') refresh()
        })
        .catch(() => undefined)
    } else {
      snapshot = collectSnapshot({ workbuddyDir: sourceDir(kind), cache: workbuddyCache })
    }
    tray?.update(snapshot)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('snapshot', snapshot)
    }
    floatWindow?.send('snapshot', snapshot)
  } catch (error) {
    // 采集失败不能中断轮询：WorkBuddy 可能正在写库
    smoke('refresh-error', { message: String(error) })
  }
  return snapshot
}

/* ------------------------------------------------------------ 设置 */

function broadcastSettings(settings: Settings): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings', settings)
  floatWindow?.send('settings', settings)
}

/** 改设置 -> 落盘 -> 广播 -> 同步窗口。一处收口，免得漏掉某条链路 */
function patchSettings(patch: Partial<Settings>): void {
  const before = settingsStore?.settings.source
  const next = settingsStore?.patch(patch)
  if (!next) return
  broadcastSettings(next)
  floatWindow?.syncFromSettings()
  tray?.notifyRefreshed()
  // 换数据源要立刻重采一次，否则界面会停在旧数据源上直到下一次轮询
  if (patch.source && patch.source !== before) refresh()
  // 外观同理：themeSource 一变，两个窗口的 prefers-color-scheme 立刻跟着走，
  // 只有「实心底色」的胶囊要主进程自己重刷窗口底色
  if (patch.theme) {
    applyTheme(next.theme)
    floatWindow?.syncTheme()
  }
}

function setFloatEnabled(enabled: boolean): void {
  const next = settingsStore?.patch({ floatEnabled: enabled })
  if (!next) return
  broadcastSettings(next)
  if (enabled) floatWindow?.show()
  else floatWindow?.hide()
  tray?.notifyRefreshed()
}

function currentFloatState(): FloatState {
  return floatWindow?.describe() ?? { created: false, visible: false, loaded: false, bounds: null }
}

/* ------------------------------------------------------------ 窗口 */

function showMainWindow(): void {
  const win = ensureMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const win = new BrowserWindow({
    // 高度按 1080p 一屏（减任务栏）能放下定，再高会被系统截断；宽度只给到 560
    width: 560,
    height: 900,
    minWidth: 460,
    minHeight: 520,
    show: false,
    title: 'Token 计量器',
    backgroundColor: windowBackground(),
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  hardenWindow(win)
  loadRenderer(win)

  // 关窗即隐藏，托盘常驻 —— 只有显式「退出」才真的走
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })

  win.once('ready-to-show', () => {
    if (SMOKE) {
      win.show()
    }
  })

  mainWindow = win
  return win
}

/* ------------------------------------------------------------ 启动 */

function bootstrap(): void {
  // 必须在创建窗口、发通知之前调用；缺失会让 Windows 通知静默失败
  app.setAppUserModelId(APP_ID)

  settingsStore = new SettingsStore()
  // 必须在建窗口之前定下来：窗口底色是创建参数，晚了会先闪一下白底
  applyTheme(settingsStore.settings.theme)

  floatWindow = new FloatWindow(
    preloadPath(),
    () => settingsStore?.settings ?? DEFAULT_SETTINGS,
    (position) => {
      settingsStore?.patch({ floatPosition: position })
    }
  )

  tray = new TrayController({
    onOpenMain: () => showMainWindow(),
    onRefresh: () => {
      refresh(true)
      tray?.notifyRefreshed()
    },
    onOpenDataDir: () => {
      void shell.openPath(sourceDir(currentSource()))
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },

    /* 数据源 */
    getSource: () => currentSource(),
    onSetSource: (kind) => patchSettings({ source: kind }),

    /* 外观 */
    getTheme: () => currentTheme(),
    onSetTheme: (mode) => patchSettings({ theme: mode }),

    /* 桌面胶囊 */
    getFloatEnabled: () => settingsStore?.settings.floatEnabled ?? false,
    onToggleFloat: (enabled) => setFloatEnabled(enabled),
    getFloatAlwaysOnTop: () => settingsStore?.settings.floatAlwaysOnTop ?? true,
    onToggleFloatAlwaysOnTop: (enabled) => patchSettings({ floatAlwaysOnTop: enabled }),
    getFloatSize: () => settingsStore?.settings.floatSize ?? 'medium',
    onSetFloatSize: (size) => patchSettings({ floatSize: size }),
    getFloatOpacity: () => settingsStore?.settings.floatOpacity ?? 0.94,
    onSetFloatOpacity: (value) => patchSettings({ floatOpacity: value }),
    getFloatSolid: () => settingsStore?.settings.floatSolidBackground ?? false,
    onToggleFloatSolid: (solid) => patchSettings({ floatSolidBackground: solid }),
    onResetFloatPosition: () => {
      floatWindow?.resetPosition()
      tray?.notifyRefreshed()
    }
  })
  tray.create()

  ensureMainWindow()

  // 跟随系统时，用户在 Windows 里切浅色 / 深色要立刻反映到两个窗口上。
  // themeSource 是 system 时 Electron 会自己更新 prefers-color-scheme，
  // 这里只需要重刷那些「不是 CSS 说了算」的地方。
  nativeTheme.on('updated', () => {
    floatWindow?.syncTheme()
    mainWindow?.setBackgroundColor(windowBackground())
  })

  // 按设置决定胶囊是否出现；自检时强制显示，否则测不到
  if (SMOKE || settingsStore.settings.floatEnabled) floatWindow.show()

  refresh()

  const timer = setInterval(refresh, REFRESH_MS)
  timer.unref?.()

  if (SMOKE) {
    setTimeout(async () => {
      // 无头环境里，截图 + DOM 度量是唯一能确认「界面真的画出来了」的手段 ——
      // 窗口 isVisible() 为 true 也可能是空白（工具环境常见，见项目 skill 坑 8）
      try {
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          const dir = join(tmpdir(), 'wbtm-smoke')
          mkdirSync(dir, { recursive: true })
          const image = await win.webContents.capturePage()
          writeFileSync(join(dir, 'window.png'), image.toPNG())
          const metrics = await win.webContents.executeJavaScript(
            `(() => {
               const heat = document.querySelector('.heatmap')
               const active = document.querySelector('.source-switch .active')
               return {
                 sections: document.querySelectorAll('.ch').length,
                 theme: document.documentElement.dataset.theme || '',
                 bodyHeight: document.body.scrollHeight,
                 title: document.querySelector('.app-title')?.textContent || '',
                 source: active ? active.textContent : '',
                 sessionRows: document.querySelectorAll('.session-row').length,
                 creditRows: document.querySelectorAll('.session-credits').length,
                 headline: [...document.querySelectorAll('.headline-value')].map((el) => el.textContent),
                 heatCells: heat ? heat.children.length : 0,
                 heatWidth: heat ? heat.clientWidth : 0,
                 heatScrollWidth: heat ? heat.scrollWidth : 0
               }
             })()`
          )
          smoke('dom', metrics)

          // 再滚到热力图截一张，确认它没有被裁掉
          await win.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('.heatmap'); if (el) el.scrollIntoView({ block: 'center' }); })()`
          )
          await new Promise((resolve) => setTimeout(resolve, 400))
          const heatShot = await win.webContents.capturePage()
          writeFileSync(join(dir, 'window-heat.png'), heatShot.toPNG())

          // 数据源切换的端到端自检：逐个点过去 -> IPC -> 重采 -> 重绘，最后切回原样。
          // 只在自检里跑，跑完立刻切回去，免得把用户自己的设置改掉。
          const sourceBefore = settingsStore?.settings.source ?? 'workbuddy'
          const switches: Array<{ expected: SourceKind; actual: SourceKind | undefined; dom: unknown }> = []
          for (const target of SOURCE_ORDER) {
            if (target === sourceBefore) continue
            // 前三个源就是按钮本身，其余收在「更多」下拉里 —— 两条路径都要真的点一遍
            const label = JSON.stringify(sourceLabel(target))
            await win.webContents.executeJavaScript(
              `(() => {
                 const root = document.querySelector('.source-switch')
                 if (!root) return
                 const direct = [...root.querySelectorAll('button')].find((el) => el.textContent.trim() === ${label})
                 if (direct) direct.click()
                 else root.querySelector('.source-more')?.click()
               })()`
            )
            await new Promise((resolve) => setTimeout(resolve, 250))
            await win.webContents.executeJavaScript(
              `(() => {
                 const item = [...document.querySelectorAll('.source-menu button')].find((el) => el.textContent.trim() === ${label})
                 if (item) item.click()
               })()`
            )
            await new Promise((resolve) => setTimeout(resolve, 1500))
            const switched = await win.webContents.executeJavaScript(
              `(() => {
                 const active = document.querySelector('.source-switch .active')
                 return {
                   active: active ? active.textContent : '',
                   subtitle: document.querySelector('.app-subtitle')?.textContent || '',
                   headline: [...document.querySelectorAll('.headline-value')].map((el) => el.textContent),
                   sessionRows: document.querySelectorAll('.session-row').length,
                   creditRows: document.querySelectorAll('.session-credits').length,
                   contextNote: document.querySelector('.gauge-foot')?.textContent || '',
                   modelHints: [...document.querySelectorAll('.bar-value em')].map((el) => el.textContent)
                 }
               })()`
            )
            // 截图前先滚回顶部：自检要能一眼看到「今日」与上下文水位这两张卡
            await win.webContents.executeJavaScript(
              `(() => { const el = document.querySelector('.app-body'); if (el) el.scrollTop = 0 })()`
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            writeFileSync(join(dir, `window-${target}.png`), (await win.webContents.capturePage()).toPNG())
            switches.push({ expected: target, actual: settingsStore?.settings.source, dom: switched })
          }
          smoke('source-switch', { from: sourceBefore, switches })
          patchSettings({ source: sourceBefore })
          await new Promise((resolve) => setTimeout(resolve, 1500))

          // 切回来之后，DOM 里的会话行数必须等于当前快照的会话数。
          // 多出来就是残留：会话快照里同一个 sessionId 会出现两次，
          // 列表 key 撞车时 React 对账会漏删，上一批行留在 DOM 里。
          const afterSwitchBack = await win.webContents.executeJavaScript(
            `(() => {
               const c = document.querySelector('.sessions')
               return {
                 source: document.querySelector('.source-switch .active')?.textContent || '',
                 rows: document.querySelectorAll('.session-row').length,
                 creditRows: document.querySelectorAll('.session-credits').length,
                 containerChildren: c ? c.children.length : -1
               }
             })()`
          )
          smoke('after-switch-back', {
            expected: sourceBefore,
            actual: settingsStore?.settings.source,
            expectedRows: Math.min((snapshot?.sessions ?? []).length, 40),
            dom: afterSwitchBack
          })

          // 顶栏在最小宽度下不能被撑破：四个数据源按钮 + 刷新挤在一行，
          // scrollWidth 超过 clientWidth 就是溢出了（窗口默认 560，最小 460）
          const originalBounds = win.getBounds()
          win.setSize(460, originalBounds.height)
          await new Promise((resolve) => setTimeout(resolve, 400))
          const narrow = await win.webContents.executeJavaScript(
            `(() => {
               const header = document.querySelector('.app-header')
               const actions = document.querySelector('.header-actions')
               return {
                 viewportWidth: window.innerWidth,
                 headerClientWidth: header ? header.clientWidth : -1,
                 headerScrollWidth: header ? header.scrollWidth : -1,
                 actionsWidth: actions ? Math.round(actions.getBoundingClientRect().width) : -1,
                 subtitle: document.querySelector('.app-subtitle')?.textContent || ''
               }
             })()`
          )
          smoke('narrow-header', narrow)
          win.setSize(originalBounds.width, originalBounds.height)
          await new Promise((resolve) => setTimeout(resolve, 300))

          // 两套外观各截一张：深色主题只有真看一眼才知道对不对，
          // 顺手把 dataset.theme 与实测底色回报出来，免得「设置改了但 CSS 没跟上」。
          const themeBefore = settingsStore?.settings.theme ?? 'system'
          const themeShots: Array<{ mode: string; actual: string | undefined; dom: unknown }> = []
          for (const mode of ['dark', 'light'] as const) {
            patchSettings({ theme: mode })
            await new Promise((resolve) => setTimeout(resolve, 700))
            const dom = await win.webContents.executeJavaScript(
              `(() => {
                 const body = getComputedStyle(document.body)
                 // 这套设计押在 Bahnschrift（DIN 血统，Win10+ 自带）上，
                 // 量一下字宽才知道它到底在不在 —— getComputedStyle 只会把 CSS 原样念回来
                 const probe = (font) => {
                   const ctx = document.createElement('canvas').getContext('2d')
                   ctx.font = '40px ' + font
                   return Math.round(ctx.measureText('Token 0123456789').width)
                 }
                 const counter = document.querySelector('.headline-value')
                 return {
                   stamped: document.documentElement.dataset.theme || '',
                   prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
                   background: body.backgroundColor,
                   color: body.color,
                   sections: document.querySelectorAll('.ch').length,
                   themeButton: document.querySelector('.theme-toggle')?.textContent || '',
                   counterFont: counter ? getComputedStyle(counter).fontFamily.split(',')[0] : '',
                   fontWidth: {
                     bahnschrift: probe('Bahnschrift'),
                     segoe: probe('"Segoe UI"'),
                     sans: probe('sans-serif')
                   }
                 }
               })()`
            )
            writeFileSync(join(dir, `window-${mode}.png`), (await win.webContents.capturePage()).toPNG())
            themeShots.push({ mode, actual: settingsStore?.settings.theme, dom })
          }
          smoke('theme', { before: themeBefore, shots: themeShots })
          patchSettings({ theme: themeBefore })
          await new Promise((resolve) => setTimeout(resolve, 400))
        }

        // 桌面胶囊单独截一张，并回报 DOM 度量
        const floatWin = floatWindow?.browserWindow
        if (floatWin && !floatWin.isDestroyed()) {
          const dir = join(tmpdir(), 'wbtm-smoke')
          const image = await floatWin.webContents.capturePage()
          writeFileSync(join(dir, 'float.png'), image.toPNG())

          // 直接用位图验四角透明 —— 只把 PNG 存下来肉眼分不出「透明」和「白」。
          // Electron 43 的类型定义把 getBitmap() 标成了 void（运行时其实返回 Buffer），
          // 这里显式断言，否则 CI 上的 typecheck 会挂。
          const pixels = image.getBitmap() as unknown as Buffer
          const size = image.getSize()
          const alphaAt = (x: number, y: number): number => pixels[(y * size.width + x) * 4 + 3]
          smoke('float-pixels', {
            size,
            corners: {
              左上: alphaAt(0, 0),
              右上: alphaAt(size.width - 1, 0),
              左下: alphaAt(0, size.height - 1),
              右下: alphaAt(size.width - 1, size.height - 1)
            },
            中心: alphaAt(Math.floor(size.width / 2), Math.floor(size.height / 2)),
            底边: alphaAt(Math.floor(size.width / 2), size.height - 2)
          })

          const metrics = await floatWin.webContents.executeJavaScript(
            `(() => {
               const el = document.querySelector('.capsule')
               return {
                 capsule: !!el,
                 tokens: document.querySelector('.tokens')?.textContent || '',
                 credits: document.querySelector('.credits')?.textContent || '',
                 capsuleSize: el ? [el.clientWidth, el.clientHeight] : null,
                 viewport: [window.innerWidth, window.innerHeight]
               }
             })()`
          )
          smoke('float-dom', metrics)
        }
      } catch (error) {
        smoke('capture-error', { message: String(error) })
      }

      smoke('ready', {
        at: Date.now(),
        appId: APP_ID,
        packaged: app.isPackaged,
        windowVisible: mainWindow?.isVisible() ?? false,
        windowDestroyed: mainWindow?.isDestroyed() ?? true,
        trayCreated: tray !== null,
        float: currentFloatState(),
        settings: settingsStore?.settings ?? null,
        snapshot: snapshot
          ? {
              kind: snapshot.kind,
              source: snapshot.source,
              sessions: snapshot.totals.sessions,
              calls: snapshot.totals.calls,
              credits: snapshot.totals.credits,
              inputTokens: snapshot.totals.inputTokens,
              outputTokens: snapshot.totals.outputTokens,
              cachedTokens: snapshot.totals.cachedTokens,
              matchedTraces: snapshot.totals.matchedTraces,
              totalTraces: snapshot.totals.traces,
              active: snapshot.active,
              warnings: snapshot.warnings
            }
          : null
      })
      if (SMOKE_EXIT) {
        isQuitting = true
        app.quit()
      }
    }, 4000)
  }
}

if (!app.requestSingleInstanceLock()) {
  smoke('locked', { at: Date.now() })
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    bootstrap()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) ensureMainWindow()
      else showMainWindow()
    })
  })

  // 托盘常驻：关掉所有窗口也不退出
  app.on('window-all-closed', () => {
    /* 故意留空 */
  })

  app.on('before-quit', () => {
    isQuitting = true
  })
}

/* ------------------------------------------------------------ IPC */

ipcMain.handle('snapshot:get', () => snapshot ?? refresh())
ipcMain.handle('snapshot:refresh', () => refresh(true))
ipcMain.handle('data:open-dir', async () => {
  const dir = sourceDir(currentSource())
  await shell.openPath(dir)
  return dir
})
ipcMain.handle('app:quit', () => {
  isQuitting = true
  app.quit()
})

/* ---- 设置与桌面胶囊 ---- */

ipcMain.handle('settings:get', () => settingsStore?.settings ?? DEFAULT_SETTINGS)
ipcMain.handle('settings:update', (_event, patch: Partial<Settings>) => {
  patchSettings(patch && typeof patch === 'object' ? patch : {})
  return settingsStore?.settings ?? DEFAULT_SETTINGS
})

// 拖动频率高，走单向消息，不需要回值
ipcMain.on('float:move', (_event, dx: unknown, dy: unknown) => {
  floatWindow?.moveBy(Number(dx) || 0, Number(dy) || 0)
})
ipcMain.on('float:open-panel', () => showMainWindow())
ipcMain.on('float:context-menu', () => tray?.popUp())
