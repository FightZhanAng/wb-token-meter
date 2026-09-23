import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSnapshot, type ParseCache } from '../shared/collector'
import { collectKimiSnapshot, type KimiParseCache } from '../shared/kimi-collector'
import type { FloatState, Settings, Snapshot, SourceKind } from '../shared/types'
import { FloatWindow } from './float'
import { appIconPath, hardenWindow, kimiDir, loadRenderer, preloadPath, workbuddyDir } from './paths'
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
/** 两个数据源各有一份解析缓存 —— 切换数据源不能把对方的增量缓存冲掉 */
const workbuddyCache: ParseCache = new Map()
const kimiCache: KimiParseCache = new Map()

/* ------------------------------------------------------------ 采集 */

/** 当前数据源的数据根目录（「打开数据目录」与采集都认它） */
function sourceDir(kind: SourceKind): string {
  return kind === 'kimi' ? kimiDir() : workbuddyDir()
}

function currentSource(): SourceKind {
  return settingsStore?.settings.source ?? DEFAULT_SETTINGS.source
}

function refresh(): Snapshot | null {
  const kind = currentSource()
  try {
    snapshot =
      kind === 'kimi'
        ? collectKimiSnapshot({ kimiDir: sourceDir(kind), cache: kimiCache })
        : collectSnapshot({ workbuddyDir: sourceDir(kind), cache: workbuddyCache })
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
    width: 560,
    height: 760,
    minWidth: 460,
    minHeight: 520,
    show: false,
    title: 'Token 计量器',
    backgroundColor: '#f4f6f9',
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
      refresh()
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
                 cards: document.querySelectorAll('.card').length,
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

          // 数据源切换的端到端自检：点按钮 -> IPC -> 重采 -> 重绘。
          // 只在自检里跑，跑完立刻切回去，免得把用户自己的设置改掉。
          const sourceBefore = settingsStore?.settings.source ?? 'workbuddy'
          const switchTarget: SourceKind = sourceBefore === 'kimi' ? 'workbuddy' : 'kimi'
          await win.webContents.executeJavaScript(
            `(() => {
               const el = [...document.querySelectorAll('.source-switch button')].find((b) => !b.classList.contains('active'))
               if (el) el.click()
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
                 modelHints: [...document.querySelectorAll('.bar-value em')].map((el) => el.textContent)
               }
             })()`
          )
          writeFileSync(join(dir, 'window-switched.png'), (await win.webContents.capturePage()).toPNG())
          smoke('source-switch', {
            from: sourceBefore,
            expected: switchTarget,
            actual: settingsStore?.settings.source,
            dom: switched
          })
          patchSettings({ source: sourceBefore })
          await new Promise((resolve) => setTimeout(resolve, 1500))

          // 切回来之后 DOM 里的行数必须和 React 自己的子节点数相等。
          // 少一行就是残留：会话快照里同一个 sessionId 会出现两次，
          // 列表 key 撞车时 React 对账会漏删，上一批行留在 DOM 里。
          const afterSwitchBack = await win.webContents.executeJavaScript(
            `(() => {
               const c = document.querySelector('.sessions')
               const key = c ? Object.keys(c).find((k) => k.startsWith('__reactFiber$')) : null
               let fiberChildren = -1
               if (key) {
                 fiberChildren = 0
                 for (let ch = c[key].child; ch; ch = ch.sibling) fiberChildren += 1
               }
               return {
                 source: document.querySelector('.source-switch .active')?.textContent || '',
                 rows: document.querySelectorAll('.session-row').length,
                 creditRows: document.querySelectorAll('.session-credits').length,
                 fiberChildren,
                 containerChildren: c ? c.children.length : -1
               }
             })()`
          )
          smoke('after-switch-back', {
            expected: sourceBefore,
            actual: settingsStore?.settings.source,
            dom: afterSwitchBack
          })
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
ipcMain.handle('snapshot:refresh', () => refresh())
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
