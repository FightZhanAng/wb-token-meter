import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPSULE_THEME_ORDER } from '../shared/capsule'
import { collectSnapshot, type ParseCache } from '../shared/collector'
import { collectDshSnapshot, type DshParseCache } from '../shared/dsh-collector'
import { SOURCE_ORDER, sourceLabel } from '../shared/format'
import { collectKimiSnapshot, type KimiParseCache } from '../shared/kimi-collector'
import { collectMimoSnapshot } from '../shared/mimo-collector'
import { collectOpencodeSnapshot } from '../shared/opencode-collector'
import { collectQoderSnapshot, type QoderParseCache } from '../shared/qoder-collector'
import { collectReasonixSnapshot, type ReasonixParseCache } from '../shared/reasonix-collector'
import { collectTraeCnSnapshot, probeTraeCnKey, traeCnFileStamp } from '../shared/traecn-collector'
import { collectZcodeSnapshot } from '../shared/zcode-collector'
import type {
  AppInfo,
  CapsuleTheme,
  FloatState,
  Settings,
  Snapshot,
  SourceKind,
  ThemeMode,
  UpdateState
} from '../shared/types'
import { FloatWindow } from './float'
import { ModelsDevCatalog } from './modelsdev'
import { OpencodeUsage } from './opencode-usage'
import {
  appIconPath,
  dshDir,
  hardenWindow,
  kimiDir,
  loadRenderer,
  mimoCacheDir,
  mimoDataDir,
  opencodeCacheDir,
  opencodeDir,
  preloadPath,
  qoderDir,
  reasonixDir,
  reasonixStatsDir,
  traeCnDbPath,
  traeCnDir,
  traeCnStatePath,
  workbuddyDir,
  zcodeDir
} from './paths'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'
import { readTraeCnKey, type TraeCnKeyProbe } from './traecn-key'
import { TrayController, type MenuChoice } from './tray'
import { UpdateController } from './updater'

/* ------------------------------------------------------------ 冒烟自检 */

// 结论写磁盘而不是 console.log —— Windows 上 GUI 进程不挂控制台，
// 只靠 stdout 经常什么都看不到，"跑没跑起来"都判断不了。
const SMOKE = process.env['WB_TOKEN_METER_SMOKE'] === '1'
const SMOKE_EXIT = process.env['WB_TOKEN_METER_SMOKE_EXIT'] === '1'

// 自检各步骤之间全是 await（截图、executeJavaScript）。渲染进程一旦无响应
// ——实测过的最常见诱因是 Chromium 的网络服务进程崩溃——这些 await 会永久挂起，
// 进程既不报错也不退出，调用方只能一直等。正常一轮约 40 秒，给到 2 分钟足够宽松。
const SMOKE_TIMEOUT_MS = 120_000

// 自检时给更新检查注入一个假版本号：既不真去打网络，又能让更新界面被完整渲染到。
// 必须在 ensureUpdater() 之前设 —— UpdateController 在构造时就把这个值读走了。
if (SMOKE && !process.env['WB_TOKEN_METER_FAKE_UPDATE']) {
  process.env['WB_TOKEN_METER_FAKE_UPDATE'] = '9.9.9'
}

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

/** 发布页 —— 「打开发布页」与更新检查失败时的兜底都指这里 */
const RELEASE_PAGE = 'https://github.com/FightZhanAng/wb-token-meter/releases'

/** 项目主页 —— 标题栏那个 GitHub 图标指这里。写死在主进程，渲染进程传不了任意 URL 进来 */
const HOME_PAGE = 'https://github.com/FightZhanAng/wb-token-meter'

/**
 * Windows 自绘标题栏条的高度（px）—— 这条里只放窗口 chrome（拖拽 + 系统三键），
 * 应用自己的标题和按钮在下面一行，所以它按系统caption 的尺寸给就够：
 * 三键本身是 32px 高（这个值不随 DPI 变，因为 CSS px 和系统缩放同步走），
 * 留一点余量给悬停高亮。必须和 styles.css 里 .app-caption 的高度对上。
 */
const CAPTION_HEIGHT = 36

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let floatWindow: FloatWindow | null = null
let settingsStore: SettingsStore | null = null
let updater: UpdateController | null = null
let isQuitting = false
let snapshot: Snapshot | null = null
/** 各数据源各有一份解析缓存 —— 切换数据源不能把对方的增量缓存冲掉 */
const workbuddyCache: ParseCache = new Map()
const kimiCache: KimiParseCache = new Map()
const qoderCache: QoderParseCache = new Map()
const reasonixCache: ReasonixParseCache = new Map()
const dshCache: DshParseCache = new Map()

/**
 * TRAE SOLO CN 的数据库密钥。**必须缓存**：唯一能取到它的办法是扫那些锁着
 * 用量库的进程的内存（实测 ~680MB / 21 秒），而 20 秒一次的轮询扛不住这个代价。
 * 同一份 TraeWork 不重启，密钥就一直有效 —— 所以只有第 1 页 HMAC 验不过
 * （App 重启换了钥）才重扫，见 ensureTraeCnKey()。
 */
let traeCnKey: Buffer | null = null
/** 上一次取密钥的结果（含「谁锁着这个库」），用来给「取不到」配一条具体的提示 */
let traeCnKeyProbe: TraeCnKeyProbe | null = null
let traeCnKeyScan: Promise<void> | null = null
let traeCnKeyCheckedAt = 0

/** 取密钥失败后的冷却：App 没开时每分钟撞一次就够了，别把轮询变成扫描器 */
const TRAECN_KEY_RETRY_MS = 60_000

/**
 * TRAE SOLO CN 的快照缓存：db + -wal 的文件戳没变就整份复用（见 refresh() 的
 * traecn 分支）。只缓存「有钥」时采的那份 —— 没钥的空账本来就不花钱，而且
 * 钥从无到有的那一拍必须真的重采，不能被上一份「没钥」的空账挡住。
 */
let traeCnStampCache: { stamp: string; snapshot: Snapshot } | null = null

function ensureTraeCnKey(force = false): Promise<void> {
  if (traeCnKey && !force) return Promise.resolve()
  if (traeCnKeyScan) return traeCnKeyScan
  if (!force && !traeCnKey && traeCnKeyProbe && Date.now() - traeCnKeyCheckedAt < TRAECN_KEY_RETRY_MS) {
    return Promise.resolve()
  }
  traeCnKeyCheckedAt = Date.now()
  traeCnKeyScan = readTraeCnKey(traeCnDbPath())
    .then((probe) => {
      traeCnKeyProbe = probe
      traeCnKey = probe.key
    })
    .catch(() => {
      traeCnKeyProbe = { pids: [], key: null }
      traeCnKey = null
    })
    .finally(() => {
      traeCnKeyScan = null
    })
  return traeCnKeyScan
}

/* ------------------------------------------------------------ 采集 */

/** OpenCode Go 的额度客户端。懒创建：只有真的切到那个源才会实例化、才会去读 auth.json */
let opencodeUsage: OpencodeUsage | null = null

/** models.dev 模型目录客户端。懒创建：只有真的切到 ZCode 源才会实例化、才会发请求 */
let modelsDev: ModelsDevCatalog | null = null

function ensureModelsDev(): ModelsDevCatalog {
  if (!modelsDev) {
    modelsDev = new ModelsDevCatalog({
      cacheFile: join(app.getPath('userData'), 'models-dev-cache.json'),
      endpoint: process.env['WB_TOKEN_METER_MODELSDEV_URL']
    })
  }
  return modelsDev
}

/** 当前数据源的数据根目录（「打开数据目录」与采集都认它） */
function sourceDir(kind: SourceKind): string {
  if (kind === 'kimi') return kimiDir()
  if (kind === 'zcode') return zcodeDir()
  if (kind === 'mimo') return mimoDataDir()
  if (kind === 'qoder') return qoderDir()
  if (kind === 'reasonix') return reasonixDir()
  if (kind === 'dsh') return dshDir()
  if (kind === 'traecn') return traeCnDir()
  if (kind === 'opencode-desktop') return opencodeDir()
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
  // caption 的两块颜色都不归 CSS 管，主题换档后要主进程自己刷一遍
  syncTitleBarOverlay()
}

function currentTheme(): ThemeMode {
  return settingsStore?.settings.theme ?? DEFAULT_SETTINGS.theme
}

/**
 * 窗口底色是**创建参数**，CSS 管不到它，只能主进程给。
 * 这两个值必须和 styles.css 的 --paper 对上（深色 #0B0E16 / 浅色 #EDF0EC），
 * 否则窗口冒出来的那一帧会先闪一下另一种颜色。core-test 盯着这一对。
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0B0E16' : '#EDF0EC'
}

/**
 * 自绘标题栏（Windows 的 Window Controls Overlay）。
 *
 * 用系统原生边框时，caption 是 DWM 画的：只要用户开着「在标题栏和窗口边框上
 * 显示强调色」，它就永远是强调色 —— 应用请求深色也没用，CSS 更是够不着
 * （caption 不在渲染层里）。想让它跟着主题走，只能自己接管：
 * 收掉原生边框，改用 titleBarOverlay，把 caption 的颜色显式给出来。
 *
 * color 用全透明（渲染层自己画，底色由 .app-caption 的 --sheet-2 决定），
 * symbolColor 必须跟着明暗给，否则浅色主题下会剩三个白按钮挂在那里。
 */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  return {
    color: '#00000000',
    // 必须和 styles.css 深色块的 --ink 对上（深色 #E9ECF6 / 浅色 #16211E），
    // 差一档就是「深色主题下三个惨白的按钮挂在机头上」
    symbolColor: nativeTheme.shouldUseDarkColors ? '#E9ECF6' : '#16211E',
    height: CAPTION_HEIGHT
  }
}

/** 主题一变，caption 的符号色要跟着换；窗口没建好、或不是 Windows，就什么都不做 */
function syncTitleBarOverlay(): void {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setTitleBarOverlay(titleBarOverlay())
  } catch {
    /* 覆盖层没启用（比如某些自检窗口）就跳过 —— 装饰性的事不该打断刷新 */
  }
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
      snapshot = collectZcodeSnapshot({ zcodeDir: sourceDir(kind), modelsDevCache: ensureModelsDev().cacheFile })
      // 远程 provider（opencode-go 系）的模型窗口不落本地 config：后台拉一次
      // models.dev 目录兜底（目录新鲜期内直接跳过）。拉到了再重采一遍，水位
      // 立刻跟上 —— 与额度源同一套「先画缓存、到了再广播」的路数。
      void ensureModelsDev()
        .pull(force)
        .then((pulled) => {
          if (pulled && currentSource() === 'zcode') refresh()
        })
        .catch(() => undefined)
    } else if (kind === 'mimo') {
      snapshot = collectMimoSnapshot({ mimoDir: sourceDir(kind), cacheDir: mimoCacheDir() })
    } else if (kind === 'qoder') {
      snapshot = collectQoderSnapshot({ qoderDir: sourceDir(kind), cache: qoderCache })
    } else if (kind === 'reasonix') {
      snapshot = collectReasonixSnapshot({
        reasonixDir: sourceDir(kind),
        statsDir: reasonixStatsDir(),
        cache: reasonixCache
      })
    } else if (kind === 'dsh') {
      snapshot = collectDshSnapshot({ dshDir: sourceDir(kind), cache: dshCache })
    } else if (kind === 'traecn') {
      const dbPath = traeCnDbPath()
      // 缓存的密钥要先验一页 HMAC 再用：TraeWork 重启会换钥，直接拿旧钥去解密
      // 只会得到一库乱码 —— 而乱码很像「库坏了」，特别容易查错方向。
      if (traeCnKey && !probeTraeCnKey(dbPath, traeCnKey)) traeCnKey = null
      // 有钥且 db+wal 都没动过，就别每 20 秒把「拷库 + 逐页 AES + 回放 WAL」整价
      // 再付一遍：TraeWork 关着的时候库是死的，重解出来的全是同一份内容。
      // 手动刷新（force）绕开缓存 —— 用户点「刷新」就该是真的重读一遍。
      const stamp = traeCnKey ? traeCnFileStamp(dbPath) : null
      if (stamp && !force && traeCnStampCache?.stamp === stamp) {
        // warnings 必须浅拷贝：这份快照往下还可能被 push「取不到钥」的提示，
        // 复用原数组会让提示在缓存里越积越多。
        snapshot = { ...traeCnStampCache.snapshot, warnings: [...traeCnStampCache.snapshot.warnings] }
      } else {
        snapshot = collectTraeCnSnapshot({ dbPath, key: traeCnKey, statePath: traeCnStatePath() })
        if (stamp) traeCnStampCache = { stamp, snapshot }
      }
      if (!traeCnKey && traeCnKeyProbe) {
        snapshot.warnings.push(
          traeCnKeyProbe.pids.length
            ? `TRAE SOLO CN 正在运行（pid ${traeCnKeyProbe.pids.join(',')}），但没在那个进程的内存里认出数据库密钥`
            : 'TRAE SOLO CN 当前没有运行，读不到用量 —— 这个数据源的密钥只存在于它的进程内存里'
        )
      }
      // 取密钥要扫 ~680MB 内存（21 秒量级），绝不能挡住这次刷新：
      // 先把「读不到」画出来，取到了再走一遍广播（与额度源同一套路数）。
      // 只认「进这分支时还没钥、ensure 扫完拿到了」的边沿：ensureTraeCnKey 在
      // 钥已缓存时是立即 resolve 的，无条件 refresh 会自己触发自己 —— 每一圈
      // 都是一次全量解密（拷库 + 逐页 AES + 回放 WAL），主进程从此忙死（卡死根因）。
      const hadTraeCnKey = traeCnKey !== null
      void ensureTraeCnKey().then(() => {
        if (!hadTraeCnKey && traeCnKey && currentSource() === 'traecn') refresh()
      })
    } else if (kind === 'opencode-desktop') {
      snapshot = collectOpencodeSnapshot({ opencodeDir: sourceDir(kind), cacheDir: opencodeCacheDir() })
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

/* ------------------------------------------------------------ 更新 */

function broadcastUpdate(state: UpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update', state)
  // 托盘菜单里有版本号与更新动作，状态一变就要重建
  tray?.refresh()
}

function currentUpdate(): UpdateState {
  return (
    updater?.describe() ?? {
      status: 'unsupported',
      current: '',
      latest: '',
      percent: 0,
      message: '更新模块未初始化',
      checkedAt: 0,
      notes: '',
      canDownload: false
    }
  )
}

function ensureUpdater(): UpdateController {
  if (!updater) {
    updater = new UpdateController({
      getAutoCheck: () => settingsStore?.settings.autoCheckUpdate ?? DEFAULT_SETTINGS.autoCheckUpdate,
      getAutoDownload: () =>
        settingsStore?.settings.autoDownloadUpdate ?? DEFAULT_SETTINGS.autoDownloadUpdate,
      onChange: (state) => broadcastUpdate(state),
      releasePage: RELEASE_PAGE
    })
  }
  return updater
}

/** 改设置 -> 落盘 -> 广播 -> 同步窗口。一处收口，免得漏掉某条链路 */
function patchSettings(patch: Partial<Settings>): void {
  const before = settingsStore?.settings.source
  const next = settingsStore?.patch(patch)
  if (!next) return
  broadcastSettings(next)
  floatWindow?.syncFromSettings()
  tray?.refresh()
  // 换数据源要立刻重采一次，否则界面会停在旧数据源上直到下一次轮询
  if (patch.source && patch.source !== before) refresh()
  // 外观同理：themeSource 一变，两个窗口的 prefers-color-scheme 立刻跟着走，
  // 只有「实心底色」的胶囊要主进程自己重刷窗口底色
  if (patch.theme) {
    applyTheme(next.theme)
    floatWindow?.syncTheme()
  }
  // 胶囊换装：令牌是 CSS 的事，广播 settings 就够了；主进程只管实心底色那一份
  if (patch.floatTheme) floatWindow?.syncTheme()
  // 更新开关：改 autoDownload 要立刻同步给 electron-updater（开着且有新版待下就马上开始）；
  // 刚把自动检查打开、且这次开机还没查过，就顺手安排一次
  if (patch.autoCheckUpdate !== undefined || patch.autoDownloadUpdate !== undefined) {
    updater?.applySettings()
    if (patch.autoCheckUpdate === true && currentUpdate().status === 'idle') {
      updater?.scheduleStartupCheck()
    }
  }
}

function setFloatEnabled(enabled: boolean): void {
  const next = settingsStore?.patch({ floatEnabled: enabled })
  if (!next) return
  broadcastSettings(next)
  if (enabled) floatWindow?.show()
  else floatWindow?.hide()
  tray?.refresh()
}

function currentFloatState(): FloatState {
  return (
    floatWindow?.describe() ?? {
      created: false,
      visible: false,
      loaded: false,
      expanded: false,
      capsule: null,
      side: 'up',
      alignRight: true,
      bounds: null
    }
  )
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
    // Windows 上自己接管标题栏：原生 caption 会被系统强调色染色，且不随主题变。
    // 别处（macOS 开发时）保持原生边框不动，traffic lights 还得留着。
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay() }
      : {}),
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
      tray?.refresh()
    },
    onOpenDataDir: () => {
      void shell.openPath(sourceDir(currentSource()))
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },

    /* 版本与更新 */
    getUpdate: () => currentUpdate(),
    onCheckUpdate: () => ensureUpdater().check(),
    onDownloadUpdate: () => ensureUpdater().download(),
    onInstallUpdate: () => ensureUpdater().install(),
    onOpenReleasePage: () => ensureUpdater().openReleasePage(),

    /* 数据源 */
    getSource: () => currentSource(),
    onSetSource: (kind) => patchSettings({ source: kind }),

    /* 外观 */
    getTheme: () => currentTheme(),
    onSetTheme: (mode) => patchSettings({ theme: mode }),

    /* 桌面胶囊 */
    getFloatEnabled: () => settingsStore?.settings.floatEnabled ?? false,
    onToggleFloat: (enabled) => setFloatEnabled(enabled),
    getFloatTheme: () => settingsStore?.settings.floatTheme ?? DEFAULT_SETTINGS.floatTheme,
    onSetFloatTheme: (theme) => patchSettings({ floatTheme: theme }),
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
      tray?.refresh()
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
    syncTitleBarOverlay()
  })

  // 按设置决定胶囊是否出现；自检时强制显示，否则测不到
  if (SMOKE || settingsStore.settings.floatEnabled) floatWindow.show()

  // 更新检查安排在数据采集之后：开机那几秒别去抢磁盘和网络
  ensureUpdater()
  updater?.scheduleStartupCheck()
  updater?.startPeriodicCheck()

  refresh()

  const timer = setInterval(refresh, REFRESH_MS)
  timer.unref?.()

  if (SMOKE) {
    // 看门狗：自检挂死时留下证据并主动退出，而不是让调用方干等
    const watchdog = setTimeout(() => {
      smoke('timeout', { limit: SMOKE_TIMEOUT_MS, at: Date.now() })
      if (SMOKE_EXIT) {
        isQuitting = true
        app.quit()
      }
    }, SMOKE_TIMEOUT_MS)
    watchdog.unref?.()

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
               const caption = document.querySelector('.app-caption')
               const guard = document.querySelector('.app-caption-guard')
               const rect = (el) => (el ? el.getBoundingClientRect() : null)
               const actionsRect = rect(actions)
               const guardRect = rect(guard)
               const captionRect = rect(caption)
               return {
                 viewportWidth: window.innerWidth,
                 headerClientWidth: header ? header.clientWidth : -1,
                 headerScrollWidth: header ? header.scrollWidth : -1,
                 actionsWidth: actionsRect ? Math.round(actionsRect.width) : -1,
                 subtitle: document.querySelector('.app-subtitle')?.textContent || '',
                 // 自绘标题栏：标题栏那条只放窗口 chrome，guardWidth 是留给系统三键的
                 // 宽度，0 就是环境变量没拿到（三键会压到应用内容上）；
                 // actionsBelowCaption 必须为 true —— 应用的按钮不能跑进标题栏那条
                 captionHeight: captionRect ? Math.round(captionRect.height) : -1,
                 guardWidth: guardRect ? Math.round(guardRect.width) : -1,
                 actionsBelowCaption:
                   actionsRect && captionRect ? Math.round(actionsRect.top) >= Math.round(captionRect.bottom) : true
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

          /* 标题栏左角的「关于」：菜单三项 -> 版本弹窗 -> 关闭。
             版本号与运行环境是主进程答的，所以这里连 IPC 一起验了。 */
          await win.webContents.executeJavaScript(
            `(() => { document.querySelector('.about-entry')?.click() })()`
          )
          await new Promise((resolve) => setTimeout(resolve, 250))
          const aboutMenu = await win.webContents.executeJavaScript(
            `(() => {
               const menu = document.querySelector('.about-menu')
               return {
                 open: !!menu,
                 items: [...(menu ? menu.querySelectorAll('button') : [])].map((el) => el.textContent.trim())
               }
             })()`
          )
          writeFileSync(join(dir, 'window-about-menu.png'), (await win.webContents.capturePage()).toPNG())

          await win.webContents.executeJavaScript(
            `(() => {
               const btn = [...document.querySelectorAll('.about-menu button')]
                 .find((el) => el.textContent.trim().startsWith('版本'))
               if (btn) btn.click()
             })()`
          )
          await new Promise((resolve) => setTimeout(resolve, 300))
          const aboutDialog = await win.webContents.executeJavaScript(
            `(() => {
               const card = document.querySelector('.about-card')
               return {
                 open: !!card,
                 version: document.querySelector('.about-number')?.textContent || '',
                 rows: [...(card ? card.querySelectorAll('.about-row') : [])].map((el) => el.textContent.trim()),
                 actions: [...(card ? card.querySelectorAll('.about-actions button') : [])].map((el) =>
                   el.textContent.trim()
                 )
               }
             })()`
          )
          writeFileSync(join(dir, 'window-about-version.png'), (await win.webContents.capturePage()).toPNG())

          await win.webContents.executeJavaScript(
            `(() => {
               const btn = [...document.querySelectorAll('.about-actions button')]
                 .find((el) => el.textContent.trim() === '关闭')
               if (btn) btn.click()
             })()`
          )
          await new Promise((resolve) => setTimeout(resolve, 200))
          const aboutClosed = await win.webContents.executeJavaScript(
            `(() => !document.querySelector('.about-card') && !document.querySelector('.about-menu'))()`
          )
          smoke('about', { menu: aboutMenu, dialog: aboutDialog, closed: aboutClosed })

          /* 底栏的版本与更新：点「检查更新」-> 发现新版本 -> 点「下载更新」-> 已就绪。
             假版本号由模块顶层的 WB_TOKEN_METER_FAKE_UPDATE 注入，全程不走网络。 */
          const settingsBeforeUpdate = { ...(settingsStore?.settings ?? DEFAULT_SETTINGS) }

          const readFooter = async (): Promise<unknown> =>
            win.webContents.executeJavaScript(
              `(() => {
                 const footer = document.querySelector('.app-footer')
                 const box = footer ? footer.getBoundingClientRect() : null
                 return {
                   version: document.querySelector('.foot-version')?.textContent || '',
                   state: document.querySelector('.foot-state')?.textContent || '',
                   status: document.querySelector('.foot-state')?.dataset.status || '',
                   actions: [...document.querySelectorAll('.foot-actions button')].map((el) => el.textContent.trim()),
                   switches: [...document.querySelectorAll('.foot-row.switches .switch')].map((el) => ({
                     label: el.textContent.trim(),
                     checked: el.querySelector('input') ? el.querySelector('input').checked : null,
                     disabled: el.querySelector('input') ? el.querySelector('input').disabled : null
                   })),
                   // 底栏是固定的一条，必须落在视口内且贴着下沿
                   footer: box
                     ? { top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: window.innerHeight }
                     : null
                 }
               })()`
            )

          const clickFooterButton = async (label: string): Promise<void> => {
            await win.webContents.executeJavaScript(
              `(() => {
                 const btn = [...document.querySelectorAll('.foot-actions button')]
                   .find((el) => el.textContent.trim() === ${JSON.stringify(label)})
                 if (btn) btn.click()
               })()`
            )
          }

          const footerIdle = await readFooter()
          await clickFooterButton('检查更新')
          await new Promise((resolve) => setTimeout(resolve, 700))
          const footerAvailable = await readFooter()
          await clickFooterButton('下载更新')
          await new Promise((resolve) => setTimeout(resolve, 700))
          const footerDownloaded = await readFooter()
          writeFileSync(join(dir, 'window-update.png'), (await win.webContents.capturePage()).toPNG())

          // 开关要真的落到设置文件里，而不是只在界面上动一下
          const autoCheckWas = settingsStore?.settings.autoCheckUpdate ?? true
          await win.webContents.executeJavaScript(
            `(() => {
               const box = document.querySelector('.foot-row.switches .switch input')
               if (box) box.click()
             })()`
          )
          await new Promise((resolve) => setTimeout(resolve, 400))
          const footerAfterToggle = await readFooter()

          smoke('update', {
            idle: footerIdle,
            available: footerAvailable,
            downloaded: footerDownloaded,
            afterToggle: footerAfterToggle,
            autoCheck: { was: autoCheckWas, now: settingsStore?.settings.autoCheckUpdate },
            state: currentUpdate()
          })

          // 自检动过的设置全部还原，别留给用户
          patchSettings({
            autoCheckUpdate: settingsBeforeUpdate.autoCheckUpdate,
            autoDownloadUpdate: settingsBeforeUpdate.autoDownloadUpdate
          })
          await new Promise((resolve) => setTimeout(resolve, 300))
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
                 viewport: [window.innerWidth, window.innerHeight],
                 theme: document.documentElement.dataset.capsule || ''
               }
             })()`
          )
          smoke('float-dom', metrics)

          /*
           * 展开卡片的端到端自检。
           *
           * 必须派发真的 pointerdown / pointerup 而不是 el.click()：
           * 单击是渲染层自己用一对指针事件判出来的（拖动与单击共用一套），
           * 合成的 click 事件根本走不到那段逻辑 —— 那样测出来的只是「能改状态」，
           * 测不到「点一下胶囊真的会展开」。
           */
          const clickCapsule = `(() => {
             const el = document.querySelector('.capsule')
             if (!el) return false
             const box = el.getBoundingClientRect()
             const at = {
               bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
               clientX: box.left + 8, clientY: box.top + box.height / 2,
               screenX: 200, screenY: 200
             }
             el.dispatchEvent(new PointerEvent('pointerdown', at))
             el.dispatchEvent(new PointerEvent('pointerup', at))
             return true
           })()`

          const collapsedBounds = floatWin.getBounds()
          const collapsedCapsule = currentFloatState().capsule
          await floatWin.webContents.executeJavaScript(clickCapsule)
          await new Promise((resolve) => setTimeout(resolve, 700))

          const cardImage = await floatWin.webContents.capturePage()
          writeFileSync(join(dir, 'float-card.png'), cardImage.toPNG())
          const cardDom = await floatWin.webContents.executeJavaScript(
            `(() => {
               const card = document.querySelector('.card')
               const el = document.querySelector('.capsule')
               return {
                 card: !!card,
                 side: card ? card.dataset.side : '',
                 align: card ? card.dataset.align : '',
                 cardSize: card ? [card.clientWidth, card.clientHeight] : null,
                 source: document.querySelector('.card-src')?.textContent || '',
                 hero: document.querySelector('.hero-value')?.textContent || '',
                 cells: [...document.querySelectorAll('.cell')].map((el) => el.textContent),
                 gauge: document.querySelector('.gauge-num')?.textContent || '',
                 bars: document.querySelectorAll('.spark i').length,
                 barHeights: [...document.querySelectorAll('.spark i')].map((el) => el.style.height || '0'),
                 cardScroll: card ? [card.clientHeight, card.scrollHeight] : null,
                 /*
                  * 分项高度 —— FLOAT_CARD.height 是写死的，改它之前得知道这 234px
                  * 到底被谁吃掉了。cardScroll 只能告诉你「溢出多少」，告诉不了
                  * 「哪一段变胖了」；字体度量一变就在这儿看得出来。
                  */
                 sections: card
                   ? [...card.children].map((node) => [
                       node.className,
                       Math.round(node.getBoundingClientRect().height)
                     ])
                   : null,
                 actions: [...document.querySelectorAll('.card-foot button')].map((el) => el.textContent),
                 pin: (() => {
                   const el = document.querySelector('.card-icon.pin')
                   return el
                     ? {
                         present: true,
                         on: el.dataset.on,
                         pressed: el.getAttribute('aria-pressed'),
                         title: el.getAttribute('title')
                       }
                     : { present: false }
                 })(),
                 capsuleSize: el ? [el.clientWidth, el.clientHeight] : null,
                 viewport: [window.innerWidth, window.innerHeight]
               }
             })()`
          )
          smoke('float-card', {
            expanded: currentFloatState().expanded,
            side: currentFloatState().side,
            before: collapsedBounds,
            after: floatWin.getBounds(),
            dom: cardDom
          })

          // 收起：卡片再点一次胶囊就该回去，且胶囊的位置不能漂
          await floatWin.webContents.executeJavaScript(clickCapsule)
          await new Promise((resolve) => setTimeout(resolve, 500))
          smoke('float-collapse', {
            expanded: currentFloatState().expanded,
            bounds: floatWin.getBounds(),
            capsuleBefore: collapsedCapsule,
            capsuleAfter: currentFloatState().capsule
          })

          /*
           * 卡片上的置顶开关：要验的是**窗口真的换了层级**，而不是按钮的 class 变了。
           *
           * 只看 DOM 的话，「点了有反应」和「窗口置顶了」是两回事 —— 前者任何
           * 一点样式变化都能满足。所以这里读 BrowserWindow.isAlwaysOnTop()：
           * 那是 DWM 视角的事实。顺手也确认设置落盘了（重启后要还是这个值）。
           *
           * 测完必须复原：把置顶关掉，否则后面那些截图步骤会在最前一层跑，
           * 报告里的层级前提就不对了。
           */
          const alwaysOnTopStep = async (): Promise<{
            before: boolean
            after: boolean
            stored: boolean
            pressed: string | null
          }> => {
            const before = floatWin.isAlwaysOnTop()
            await floatWin.webContents.executeJavaScript(
              `(() => { const el = document.querySelector('.card-icon.pin'); if (el) el.click(); return !!el })()`
            )
            await new Promise((resolve) => setTimeout(resolve, 400))
            const after = floatWin.isAlwaysOnTop()
            const pressed = await floatWin.webContents.executeJavaScript(
              `document.querySelector('.card-icon.pin')?.getAttribute('aria-pressed') ?? null`
            )
            return { before, after, stored: settingsStore?.settings.floatAlwaysOnTop ?? before, pressed }
          }

          // 先展开卡片（置顶按钮在卡片头上）
          await floatWin.webContents.executeJavaScript(clickCapsule)
          await new Promise((resolve) => setTimeout(resolve, 700))
          const onTopOff = await alwaysOnTopStep()
          // 再点回来，确认它是个开关而不是单向置位
          const onTopOn = await alwaysOnTopStep()
          await smoke('float-always-on-top', {
            off: onTopOff,
            back: onTopOn,
            restored: floatWin.isAlwaysOnTop(),
            stored: settingsStore?.settings.floatAlwaysOnTop ?? null
          })
          // 复原成默认的置顶（true），让后续步骤的层级前提与基线一致
          if (!floatWin.isAlwaysOnTop()) {
            await alwaysOnTopStep()
            await new Promise((resolve) => setTimeout(resolve, 300))
          }


          /*
           * 每个胶囊主题各截两张：收起态的胶囊、展开态的卡片。
           * 主题是**独立于面板**的一条轴，所以这里不看 prefers-color-scheme，
           * 只看 data-capsule 有没有被解析成对应那一档。
           *
           * 卡片也必须一起看：它和胶囊用的是同一份令牌，但「胶囊颜色对了」
           * 推不出「卡片也对了」—— 卡片上一堆底色、分隔线、刻度槽的搭配只有
           * 亲眼看截图才判得出来，而它恰恰是展开后用户盯着的那一块。
           * 顺手把每档的 cardScroll 记下来：溢出对主题无关，但换主题会换掉
           * 字体外的所有东西，多一列冗余的证词不亏。
           */
          const themeBefore = settingsStore?.settings.floatTheme ?? 'auto'
          const themes: Array<{
            theme: CapsuleTheme
            resolved: string
            cardScroll: number[] | null
            menu: MenuChoice[]
            menuAgree: boolean
          }> = []
          for (const theme of CAPSULE_THEME_ORDER) {
            patchSettings({ floatTheme: theme })
            /*
             * 立刻把菜单读出来，**不给下一次快照留重建的机会** —— 这一条要测的正是
             * 「设置一变就重建」。菜单里那几项标题带着当前档位（「胶囊主题：深靛」），
             * 子菜单里还有一个被勾中的项，两个说法必须一致。
             * 不一致的表现是：圆点被系统挪到了新档位、标题还停在旧档位。
             */
            const menu = tray?.describeChoices() ?? []
            const menuAgree = menu
              .filter((entry) => entry.label.includes('：'))
              .every((entry) => entry.label.split('：')[1] === entry.checked)
            await new Promise((resolve) => setTimeout(resolve, 400))
            const resolved = await floatWin.webContents.executeJavaScript(
              `document.documentElement.dataset.capsule || ''`
            )
            writeFileSync(join(dir, `float-${theme}.png`), (await floatWin.webContents.capturePage()).toPNG())

            // 点一下展开、再点一下收起 —— 同一个 clickCapsule 脚本就能来回切
            await floatWin.webContents.executeJavaScript(clickCapsule)
            await new Promise((resolve) => setTimeout(resolve, 600))
            writeFileSync(join(dir, `float-card-${theme}.png`), (await floatWin.webContents.capturePage()).toPNG())
            const cardScroll = await floatWin.webContents.executeJavaScript(
              `(() => { const c = document.querySelector('.card'); return c ? [c.clientHeight, c.scrollHeight] : null })()`
            )
            await floatWin.webContents.executeJavaScript(clickCapsule)
            await new Promise((resolve) => setTimeout(resolve, 400))
            themes.push({ theme, resolved, cardScroll, menu, menuAgree })
          }
          smoke('float-theme', { before: themeBefore, themes })
          patchSettings({ floatTheme: themeBefore })
          await new Promise((resolve) => setTimeout(resolve, 300))
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
        update: currentUpdate(),
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
      clearTimeout(watchdog)
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

/* 「关于 → 版本」弹窗：版本号与运行环境只有主进程知道，渲染层问一次就够 */
ipcMain.handle(
  'app:info',
  (): AppInfo => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    settingsFile: settingsStore?.dataFile ?? ''
  })
)

/* 只开项目主页，不接受渲染进程传来的地址 —— 免得变成任意 URL 的开口 */
ipcMain.handle('app:open-home', async () => {
  await shell.openExternal(HOME_PAGE)
  return HOME_PAGE
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
// 单击胶囊 = 展开 / 收起悬浮卡片（不再直接开面板，那一步挪到卡片里）
ipcMain.on('float:toggle-card', () => floatWindow?.toggleExpand())
ipcMain.on('float:collapse-card', () => floatWindow?.setExpanded(false))
// 收起握手：渲染层把卡片拆掉并呈现了一帧，这时缩窗正好无感（见 FloatWindow.setExpanded）
ipcMain.on('float:content-settled', () => floatWindow?.contentSettled())
ipcMain.handle('float:state', () => currentFloatState())
ipcMain.on('float:open-panel', () => {
  // 进面板前先把卡片收掉：留着它只会和主窗口抢眼球
  floatWindow?.setExpanded(false)
  showMainWindow()
})
ipcMain.on('float:context-menu', () => tray?.popUp())

/* ---- 版本与更新 ---- */

ipcMain.handle('update:get', () => currentUpdate())
ipcMain.handle('update:check', () => {
  ensureUpdater().check()
  return currentUpdate()
})
ipcMain.handle('update:download', () => {
  ensureUpdater().download()
  return currentUpdate()
})
ipcMain.handle('update:install', () => {
  ensureUpdater().install()
  return currentUpdate()
})
ipcMain.handle('update:open-page', () => {
  ensureUpdater().openReleasePage()
  return RELEASE_PAGE
})
