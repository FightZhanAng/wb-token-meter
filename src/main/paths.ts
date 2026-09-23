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
