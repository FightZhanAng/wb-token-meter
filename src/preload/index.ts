import { contextBridge, ipcRenderer } from 'electron'
import type { Settings, Snapshot } from '../shared/types'

const api = {
  /* 用量数据 */
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:get') as Promise<Snapshot>,
  refresh: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:refresh') as Promise<Snapshot>,
  openDataDir: (): Promise<string> => ipcRenderer.invoke('data:open-dir') as Promise<string>,
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit') as Promise<void>,
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
  openPanel: (): void => {
    ipcRenderer.send('float:open-panel')
  },
  /** 在胶囊上右键时弹出菜单（复用托盘那一份） */
  openFloatMenu: (): void => {
    ipcRenderer.send('float:context-menu')
  },

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
  }
}

contextBridge.exposeInMainWorld('meter', api)

export type MeterApi = typeof api
