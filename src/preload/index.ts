import { contextBridge, ipcRenderer } from 'electron'
import { resolveCapsuleTheme } from '../shared/capsule'
import type {
  AppInfo,
  CapsuleTheme,
  FloatCardSide,
  FloatState,
  Settings,
  Snapshot,
  UpdateState
} from '../shared/types'

/*
 * preload 跑在渲染进程里，能碰到 DOM —— 但这个文件归 tsconfig.node 管（它同时管主进程），
 * 那份 lib 里只有 ES2022。给用到的两个东西补一份最小声明，
 * 比为了它给整个主进程打开 DOM 类型安全得多（主进程里出现 document 也该是错的）。
 */
declare const document: { documentElement?: { dataset: Record<string, string> } } | undefined
declare function matchMedia(query: string): { matches: boolean }

/**
 * 胶囊主题是**启动参数**带进来的（见 main/float.ts 的 additionalArguments）。
 *
 * 为什么不走 IPC 问一遍：胶囊是个不透明小窗，首帧画错颜色就是一次肉眼可见的闪烁，
 * 而一个 IPC 往返赶不上第一帧。preload 跑在页面脚本与样式表之前，
 * 在这里把属性写到 <html> 上，第一帧就已经是对的。
 */
function bootCapsuleTheme(): CapsuleTheme | undefined {
  const arg = process.argv.find((value) => value.startsWith('--wbm-capsule-theme='))
  if (!arg) return undefined
  const theme = arg.slice('--wbm-capsule-theme='.length) as CapsuleTheme
  const root = document?.documentElement
  if (root) {
    root.dataset['capsuleTheme'] = theme
    root.dataset['capsule'] = resolveCapsuleTheme(theme, matchMedia('(prefers-color-scheme: dark)').matches)
  }
  return theme
}

const initialCapsuleTheme = bootCapsuleTheme()

const api = {
  /* 用量数据 */
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:get') as Promise<Snapshot>,
  refresh: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:refresh') as Promise<Snapshot>,
  openDataDir: (): Promise<string> => ipcRenderer.invoke('data:open-dir') as Promise<string>,
  /** 在系统浏览器里打开项目主页（地址写死在主进程） */
  openHome: (): Promise<string> => ipcRenderer.invoke('app:open-home') as Promise<string>,
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit') as Promise<void>,
  /** 「关于 → 版本」弹窗用的版本号与运行环境 */
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  /** 订阅主进程推送；返回取消订阅函数 */
  onSnapshot: (handler: (snapshot: Snapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: Snapshot): void => handler(snapshot)
    ipcRenderer.on('snapshot', listener)
    return () => {
      ipcRenderer.off('snapshot', listener)
    }
  },

  /* 桌面胶囊 —— 拖动走 send，高频且不需要回值 */
  moveFloat: (dx: number, dy: number): void => {
    ipcRenderer.send('float:move', dx, dy)
  },
  /** 单击胶囊：展开 / 收起那张悬浮卡片。窗口怎么撑开是主进程的事 */
  toggleFloatCard: (): void => {
    ipcRenderer.send('float:toggle-card')
  },
  collapseFloatCard: (): void => {
    ipcRenderer.send('float:collapse-card')
  },
  /** 收起的内容画完并呈现了一帧 —— 主进程收到它才缩窗口，卡片才不会被硬切一帧 */
  floatContentSettled: (): void => {
    ipcRenderer.send('float:content-settled')
  },
  getFloatState: (): Promise<FloatState> => ipcRenderer.invoke('float:state') as Promise<FloatState>,
  /** 主进程撑完窗口后回报展开状态 —— 渲染层照着它决定画什么、往哪边贴 */
  onFloatExpanded: (
    handler: (state: { expanded: boolean; side: FloatCardSide; alignRight: boolean }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      state: { expanded: boolean; side: FloatCardSide; alignRight: boolean }
    ): void => handler(state)
    ipcRenderer.on('float:expanded', listener)
    return () => {
      ipcRenderer.off('float:expanded', listener)
    }
  },
  /** 卡片里的「打开面板」 */
  openPanel: (): void => {
    ipcRenderer.send('float:open-panel')
  },
  /** 在胶囊上右键时弹出菜单（复用托盘那一份） */
  openFloatMenu: (): void => {
    ipcRenderer.send('float:context-menu')
  },
  /** 启动时那一档胶囊主题，供渲染层在挂载前同步落定 */
  initialCapsuleTheme,

  /* 设置 */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch) as Promise<Settings>,
  onSettings: (handler: (settings: Settings) => void): (() => void) => {
    const listener = (_event: unknown, settings: Settings): void => handler(settings)
    ipcRenderer.on('settings', listener)
    return () => {
      ipcRenderer.off('settings', listener)
    }
  },

  /* 版本与更新 */
  getUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:get') as Promise<UpdateState>,
  checkUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:check') as Promise<UpdateState>,
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download') as Promise<UpdateState>,
  installUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:install') as Promise<UpdateState>,
  openReleasePage: (): Promise<string> => ipcRenderer.invoke('update:open-page') as Promise<string>,
  onUpdate: (handler: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdateState): void => handler(state)
    ipcRenderer.on('update', listener)
    return () => {
      ipcRenderer.off('update', listener)
    }
  }
}

contextBridge.exposeInMainWorld('meter', api)

export type MeterApi = typeof api
