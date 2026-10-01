import type {
  AppInfo,
  CapsuleTheme,
  FloatCardSide,
  FloatState,
  Settings,
  Snapshot,
  UpdateState
} from '../shared/types'

declare global {
  interface Window {
    /** preload 通过 contextBridge 注入；缺失时界面必须还能渲染 */
    meter?: {
      getSnapshot(): Promise<Snapshot>
      refresh(): Promise<Snapshot>
      openDataDir(): Promise<string>
      /** 在系统浏览器里打开项目主页（地址写死在主进程） */
      openHome(): Promise<string>
      quit(): Promise<void>
      /** 「关于 → 版本」弹窗用的版本号与运行环境 */
      getAppInfo(): Promise<AppInfo>
      onSnapshot(handler: (snapshot: Snapshot) => void): () => void

      /** 桌面胶囊：拖动走单向消息，高频且不需要回值 */
      moveFloat(dx: number, dy: number): void
      /** 单击胶囊 —— 展开 / 收起悬浮卡片 */
      toggleFloatCard(): void
      collapseFloatCard(): void
      /** 展开状态的内容切换已呈现一帧（收起的缩窗握手） */
      floatContentSettled(): void
      getFloatState(): Promise<FloatState>
      onFloatExpanded(handler: (state: { expanded: boolean; side: FloatCardSide; alignRight: boolean }) => void): () => void
      /** 卡片里的「打开面板」 */
      openPanel(): void
      /** 在胶囊上右键时弹出菜单 */
      openFloatMenu(): void
      /** 启动参数带来的胶囊主题；主窗口里为 undefined */
      initialCapsuleTheme?: CapsuleTheme

      getSettings(): Promise<Settings>
      updateSettings(patch: Partial<Settings>): Promise<Settings>
      onSettings(handler: (settings: Settings) => void): () => void

      /* 版本与更新 */
      getUpdate(): Promise<UpdateState>
      checkUpdate(): Promise<UpdateState>
      downloadUpdate(): Promise<UpdateState>
      installUpdate(): Promise<UpdateState>
      openReleasePage(): Promise<string>
      onUpdate(handler: (state: UpdateState) => void): () => void
    }
  }
}

export {}
