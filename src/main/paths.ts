import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 资源目录。开发时是项目根的 resources/，打包后由 electron-builder 的
 * extraResources 复制到 <app>/resources/assets/。
 */
export function assetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'resources')
}

export function appIconPath(): string {
  return join(assetsDir(), 'icon.png')
}

const trayCache = new Map<number, NativeImage>()

/** 按比例取托盘图标；比例按 10% 一档量化，正好对上预生成的 11 帧 */
export function trayIconImage(ratio: number): NativeImage {
  const bucket = Math.min(100, Math.max(0, Math.round((ratio * 100) / 10) * 10))
  const cached = trayCache.get(bucket)
  if (cached) return cached
  const image = nativeImage.createFromPath(join(assetsDir(), 'tray', `tray-${bucket}.png`))
  trayCache.set(bucket, image)
  return image
}

export function preloadPath(): string {
  // electron-vite 5 默认产出 ESM，扩展名是 .mjs；留个 .js 兜底，
  // 免得哪天改了产物格式就静默挂掉
  const esm = join(__dirname, '../preload/index.mjs')
  return existsSync(esm) ? esm : join(__dirname, '../preload/index.js')
}

/** WorkBuddy 的本地数据目录 */
export function workbuddyDir(): string {
  const override = process.env['WB_TOKEN_METER_DIR']
  if (override) return override
  return join(homedir(), '.workbuddy')
}

/** Kimi Code 的本地数据目录（桌面端与 CLI 共用这一份） */
export function kimiDir(): string {
  const override = process.env['WB_TOKEN_METER_KIMI_DIR']
  if (override) return override
  return join(homedir(), '.kimi-code')
}

/** ZCode 的本地数据目录（用量库在 <zcodeDir>/cli/db/db.sqlite） */
export function zcodeDir(): string {
  const override = process.env['WB_TOKEN_METER_ZCODE_DIR']
  if (override) return override
  return join(homedir(), '.zcode')
}

/**
 * MiMo（mimocode 引擎）的数据目录。
 * 注意不是 ~/.mimocode —— 那是插件工作区，用量库在 ~/.local/share/mimocode。
 */
export function mimoDataDir(): string {
  const override = process.env['WB_TOKEN_METER_MIMO_DIR']
  if (override) return override
  return join(homedir(), '.local', 'share', 'mimocode')
}

/** MiMo 引擎的缓存目录，模型目录 models.json 在这里 */
export function mimoCacheDir(): string {
  const override = process.env['WB_TOKEN_METER_MIMO_CACHE_DIR']
  if (override) return override
  return join(homedir(), '.cache', 'mimocode')
}

/**
 * OpenCode 引擎的数据目录。用量库 opencode.db 与凭证 auth.json 都在这里 ——
 * 桌面端（engine sidecar）与 CLI 共用同一份。
 * 注意它是 mimocode 在 ~/.local/share 下的兄弟目录，别混。
 */
export function opencodeDir(): string {
  const override = process.env['WB_TOKEN_METER_OPENCODE_DIR']
  if (override) return override
  return join(homedir(), '.local', 'share', 'opencode')
}

/** OpenCode 引擎的缓存目录，模型目录 models.json 在这里（算上下文窗口用） */
export function opencodeCacheDir(): string {
  const override = process.env['WB_TOKEN_METER_OPENCODE_CACHE_DIR']
  if (override) return override
  return join(homedir(), '.cache', 'opencode')
}

/**
 * Reasonix 旧版数据目录（2026-06 前的桌面端与 CLI 共用这一份；新版桌面端不再写
 * 这里，改记 reasonixStatsDir()，两本账都要读）。
 * 用量流水是 <dir>/usage.jsonl，会话元数据在 <dir>/sessions/*.meta.json。
 * 同目录下的 config.json 存着明文 apiKey，采集器刻意不碰。
 */
export function reasonixDir(): string {
  const override = process.env['WB_TOKEN_METER_REASONIX_DIR']
  if (override) return override
  return join(homedir(), '.reasonix')
}

/**
 * Reasonix 桌面端新版（2026-06 起）的按天流水目录。新版引擎把账从 ~/.reasonix
 * 挪进了 Electron 标准数据目录（Windows 是 %APPDATA%\reasonix），按天一份 jsonl。
 * app.getPath('appData') 给的就是那个标准基址，跨平台与 Reasonix 自己的落盘一致。
 */
export function reasonixStatsDir(): string {
  const override = process.env['WB_TOKEN_METER_REASONIX_STATS_DIR']
  if (override) return override
  return join(app.getPath('appData'), 'reasonix', 'stats')
}

/** DeepSeek Harness 的数据目录；会话日志在 <dir>/sessions/<工作目录>/<会话>/ 下 */
export function dshDir(): string {
  const override = process.env['WB_TOKEN_METER_DSH_DIR']
  if (override) return override
  return join(homedir(), '.dsh')
}

/**
 * TRAE SOLO CN（TraeWork CN）的数据目录 —— 用量库 database.db 就在这一层。
 *
 * 它用的是 Electron 的标准 userData 基址，目录名取 product.json 里的
 * win32NameVersion（'TraeWork CN' 是应用名，数据目录却是 'TRAE SOLO CN'，
 * 两者不一致，别照名字猜）。库本身是 SQLCipher 4 加密的，
 * 密钥只能从运行中的进程内存里取，见 shared/traecn-collector.ts 的说明。
 */
export function traeCnDir(): string {
  const override = process.env['WB_TOKEN_METER_TRAECN_DIR']
  if (override) return override
  return join(app.getPath('appData'), 'TRAE SOLO CN', 'ModularData', 'ai-agent')
}

/** 用量库的完整路径 —— 取密钥（按文件问谁锁着它）与采集都认它 */
export function traeCnDbPath(): string {
  return join(traeCnDir(), 'database.db')
}

/**
 * Qoder CN 的数据目录（IDE 与 CLI 共用这一份）。
 * 会话记录在 <dir>/projects/<项目转义名>/<会话id>.jsonl。
 * 同目录下还有 .auth、.models 等私有文件，采集器只扫 projects/。
 */
export function qoderDir(): string {
  const override = process.env['WB_TOKEN_METER_QODER_DIR']
  if (override) return override
  return join(homedir(), '.qoder-cn')
}

export type RendererPage = 'index' | 'float'

/** 按页面名加载渲染层；开发走 dev server，生产走打包后的 HTML */
export function loadRenderer(win: BrowserWindow, page: RendererPage = 'index'): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(`${devServer}/${page}.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`))
  }
}

/** 统一的窗口加固：禁止新开窗口、禁止外部导航 */
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
  })
}
