import type { Settings, Snapshot } from '../shared/types'

declare global {
  interface Window {
    /** preload 通过 contextBridge 注入；缺失时界面必须还能渲染 */
    meter?: {
      getSnapshot(): Promise<Snapshot>
      refresh(): Promise<Snapshot>
      openDataDir(): Promise<string>
      quit(): Promise<void>
      onSnapshot(handler: (snapshot: Snapshot) => void): () => void

      /** 桌面胶囊：拖动走单向消息，高频且不需要回值 */
      moveFloat(dx: number, dy: number): void
      openPanel(): void
      /** 在胶囊上右键时弹出菜单 */
      openFloatMenu(): void

      getSettings(): Promise<Settings>
      updateSettings(patch: Partial<Settings>): Promise<Settings>
      onSettings(handler: (settings: Settings) => void): () => void
    }
  }
}

export {}
