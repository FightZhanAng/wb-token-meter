import type { BrowserWindow } from 'electron'
import type { FloatState, Settings, Snapshot, UpdateState } from '../../shared/types'
import type { FloatWindow } from '../float'
import type { TrayController } from '../tray'

/**
 * 自检要用到的全部外部状态。
 *
 * 全是取值函数而不是直接传对象：主窗口会被关掉再建（托盘点「打开面板」），
 * settings store 与托盘也是 bootstrap 里才赋值 —— 传快照就取到旧的了。
 *
 * 这里刻意**不**暴露写能力：自检唯一允许改动的东西是设置，且必须走
 * patchSettings（它会落盘 + 广播，还原时才是用户真正的原值）。
 */
export interface SmokeContext {
  appId: string
  mainWindow(): BrowserWindow | null
  floatWindow(): FloatWindow | null
  tray(): TrayController | null
  /** 可能还没建好 —— 调用方沿用原来的 `?.` 写法，避免语义漂移 */
  settings(): Settings | null
  patchSettings(patch: Partial<Settings>): void
  currentUpdate(): UpdateState
  floatState(): FloatState
  snapshot(): Snapshot | null
  quit(): void
}
