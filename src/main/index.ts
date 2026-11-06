import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { collectSnapshot, type ParseCache } from '../shared/collector'
import { collectDshSnapshot, type DshParseCache } from '../shared/dsh-collector'
import { collectKimiSnapshot, type KimiParseCache } from '../shared/kimi-collector'
import { collectMimoSnapshot } from '../shared/mimo-collector'
import { collectOpencodeSnapshot } from '../shared/opencode-collector'
import { collectQoderSnapshot, type QoderParseCache } from '../shared/qoder-collector'
import { collectReasonixSnapshot, type ReasonixParseCache } from '../shared/reasonix-collector'
import { collectTraeCnSnapshot, probeTraeCnKey, traeCnFileStamp } from '../shared/traecn-collector'
import { collectZcodeSnapshot } from '../shared/zcode-collector'
import type {
  AppInfo,
  CreditsInfo,
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
import { TraeCnUsage } from './traecn-usage'
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
import { runSmoke } from './smoke'
import { SMOKE, smoke } from './smoke/writer'
import { readTraeCnKey, type TraeCnKeyProbe } from './traecn-key'
import { TrayController } from './tray'
import { UpdateController } from './updater'

/* ------------------------------------------------------------ 冒烟自检 */

// 自检时给更新检查注入一个假版本号：既不真去打网络，又能让更新界面被完整渲染到。
// 必须在 ensureUpdater() 之前设 —— UpdateController 在构造时就把这个值读走了。
// 这段留在主入口而不是 smoke 模块里，是因为它必须早于任何模块读这个变量。
if (SMOKE && !process.env['WB_TOKEN_METER_FAKE_UPDATE']) {
  process.env['WB_TOKEN_METER_FAKE_UPDATE'] = '9.9.9'
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
 * Trae CN 的数据库密钥。**必须缓存**：唯一能取到它的办法是扫那些锁着
 * 用量库的进程的内存（实测 ~680MB、20~30 秒），而 20 秒一次的轮询扛不住这个代价。
 * 同一份 Trae CN 不重启，密钥就一直有效 —— 所以只有第 1 页 HMAC 验不过
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
 * Trae CN 的快照缓存：db + -wal 的文件戳没变就整份复用（见 refresh() 的
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
      traeCnKeyProbe = { pids: [], key: null, tokens: [] }
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
 * 这两个值必须和 styles.css 的 --paper 对上（深色 #000000 / 浅色 #FFFFFF），
 * 否则窗口冒出来的那一帧会先闪一下另一种颜色。core-test 盯着这一对。
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#000000' : '#FFFFFF'
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
    // 必须和 styles.css 深色块的 --ink 对上（深色 #F5F5F7 / 浅色 #1D1D1F），
    // 差一档就是「深色主题下三个惨白的按钮挂在机头上」
    symbolColor: nativeTheme.shouldUseDarkColors ? '#F5F5F7' : '#1D1D1F',
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

/** Trae CN 云端积分的客户端。懒创建：只有真的切到 traecn 才会实例化、才会打接口 */
let traeCnUsage: TraeCnUsage | null = null

function ensureTraeCnUsage(): TraeCnUsage {
  if (!traeCnUsage) {
    traeCnUsage = new TraeCnUsage({ endpoint: process.env['WB_TOKEN_METER_TRAECN_CREDITS_URL'] })
  }
  return traeCnUsage
}

/**
 * 积分卡要的那份数据。
 *
 * 这里只做「把客户端的内部状态摊成界面认的形状」；取数的节奏（节流 / 退避 /
 * 去重）全在 TraeCnUsage 里，跟额度源一模一样 —— 别在刷新这一侧再叠一层判断。
 */
function traeCnCreditsInfo(usage: TraeCnUsage): CreditsInfo {
  const state = usage.current()
  return {
    consumed: state.data?.consumed ?? 0,
    total: state.data?.total ?? 0,
    // 服务端给 0..1，界面要 0..100：换算只做一次，就放在这里
    percent: Math.round((state.data?.ratio ?? 0) * 1000) / 10,
    packs: state.data?.packs ?? [],
    fetchedAt: state.fetchedAt,
    stale: state.stale,
    error: state.error,
    endpoint: usage.endpoint,
    credential: usage.credentialLabel()
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
      // 缓存的密钥要先验一页 HMAC 再用：Trae CN 重启会换钥，直接拿旧钥去解密
      // 只会得到一库乱码 —— 而乱码很像「库坏了」，特别容易查错方向。
      if (traeCnKey && !probeTraeCnKey(dbPath, traeCnKey)) traeCnKey = null
      // 有钥且 db+wal 都没动过，就别每 20 秒把「拷库 + 逐页 AES + 回放 WAL」整价
      // 再付一遍：Trae CN 关着的时候库是死的，重解出来的全是同一份内容。
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
        // 说真话：扫描还没跑完时不能说「App 没在跑」—— 那时候根本还不知道
        // Trae CN 开没开。这两种情况对用户的动作完全不同（等 vs 去启动它），
        // 混成一条提示只会让人以为真出问题了。
        snapshot.warnings.push(
          traeCnKeyProbe.pids.length
            ? `Trae CN 正在运行（pid ${traeCnKeyProbe.pids.join(',')}），但没在那个进程的内存里认出数据库密钥`
            : 'Trae CN 当前没有运行，读不到用量 —— 这个数据源的密钥只存在于它的进程内存里'
        )
      }
      // 取密钥要扫 ~680MB 内存（21 秒量级），绝不能挡住这次刷新：
      // 先把「读不到」画出来，取到了再走一遍广播（与额度源同一套路数）。
      // 只认「进这分支时还没钥、ensure 扫完拿到了」的边沿：ensureTraeCnKey 在
      // 钥已缓存时是立即 resolve 的，无条件 refresh 会自己触发自己 —— 每一圈
      // 都是一次全量解密（拷库 + 逐页 AES + 回放 WAL），主进程从此忙死（卡死根因）。
      const hadTraeCnKey = traeCnKey !== null
      // 扫密钥这段空窗必须如实标出来：上面那张「全 0」快照不是读完了读出 0，
      // 而是一行都没读到。界面靠这个字段画骨架而不是画 0（见 types 的 PendingReason）。
      if (!traeCnKey && !traeCnKeyProbe) {
        snapshot.pending = 'key-scan'
        // 采集器自己那条「没取到密钥（没在运行？）」在扫描期间是**假的** ——
        // 那时候还没开始扫，根本不知道 Trae CN 开没开。留着它等于同时说
        // 「正在读」和「读不到」，界面会自己打架。骨架里本来就会说明在等什么。
        snapshot.warnings = snapshot.warnings.filter((warning) => !warning.includes('密钥'))
      }
      // 积分单独挂上去，**不能跟着 token 那本 stamp 缓存走**：库没动不代表积分没动
      // （积分是每用完一次就从云端扣的）。stamp 命中时 snapshot 是缓存的浅拷贝，
      // 在这里赋值只动这一份，缓存里那份不受影响。
      const credits = ensureTraeCnUsage()
      snapshot.credits = traeCnCreditsInfo(credits)
      void ensureTraeCnKey().then(() => {
        if (!hadTraeCnKey && traeCnKey && currentSource() === 'traecn') refresh()
        // 积分要拿内存里那批 JWT 去验（200 才算数），所以只能等扫描跑完再发请求。
        // pull 自带去重与节流，重入到这里只会拿到 false，不会绕成死循环。
        void credits
          .pull(traeCnKeyProbe?.tokens ?? [], force)
          .then((pulled) => {
            if (pulled && currentSource() === 'traecn') refresh()
          })
          .catch(() => undefined)
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
    // 面板关着（隐藏 / 已最小化）就不推：一次 send 会让那棵 1500 行的组件树
    // 重渲染一遍，而用户根本看不见。重新露出来时由 show / restore 补推，
    // 所以不会停在旧数据上。
    if (mainWindow && !mainWindow.isDestroyed() && panelIsVisible(mainWindow)) {
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

/**
 * 面板此刻是不是真的在屏幕上。
 *
 * `isVisible()` 在 Windows 上对最小化的窗口仍然返回 true —— 只判它不够，
 * 否则「最小化后还在每 20 秒重渲染一次」这个优化等于没做。
 */
function panelIsVisible(win: BrowserWindow): boolean {
  return win.isVisible() && !win.isMinimized()
}

/** 把当前快照补推一次 —— 用来填上「隐藏期间不推送」留下的那段空窗 */
function pushSnapshot(win: BrowserWindow): void {
  if (!snapshot || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('snapshot', snapshot)
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

  // 隐藏 / 最小化期间不推快照（见 refresh），所以露出来的这一拍必须补一次：
  // 否则界面要等下一个 20 秒轮询，用户看到的是刚才那一刻的旧数。
  // 首次 show 时页面可能还没加载完，send 会丢 —— 渲染层 mount 时会自己取一次。
  win.on('show', () => pushSnapshot(win))
  win.on('restore', () => pushSnapshot(win))

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

  // 自检的全部内容在 ./smoke 里 —— 它是产品代码之外的验收工具，不该继续
  // 占着启动流程的版面（这一段曾经有 700 行，改任何启动逻辑都得穿过它）。
  // SMOKE=0 时 runSmoke 自己会立刻返回，所以这里不用再包一层 if。
  runSmoke({
    appId: APP_ID,
    mainWindow: () => mainWindow,
    floatWindow: () => floatWindow,
    tray: () => tray,
    settings: () => settingsStore?.settings ?? null,
    patchSettings,
    currentUpdate,
    floatState: currentFloatState,
    snapshot: () => snapshot,
    quit: () => {
      isQuitting = true
      app.quit()
    }
  })
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

/**
 * 渲染层传来的数值一律先过这一关。
 *
 * `Number(dx) || 0` 挡得住 NaN 和字符串，但挡不住 Infinity —— 而 Infinity
 * 一旦加进 origin，窗口就被送到屏幕外去了，还会跟着 onMoved 落盘成下次启动的
 * 位置（重启后 isReachable 才发现，那时用户已经找不到胶囊了）。
 */
function finiteOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// 拖动频率高，走单向消息，不需要回值
ipcMain.on('float:move', (_event, dx: unknown, dy: unknown) => {
  floatWindow?.moveBy(finiteOrZero(dx), finiteOrZero(dy))
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
