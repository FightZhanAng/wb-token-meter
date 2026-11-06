import type { ThemeMode } from '@shared/types'

/**
 * 把 `<html data-theme>` 和外观档位绑在一起。
 *
 * 外观最终由主进程的 `nativeTheme.themeSource` 决定（跟随系统 / 浅色 / 深色），
 * 在页面里表现为 prefers-color-scheme。但「设置改了」和「媒体查询更新」不是同一时刻 ——
 * 广播到渲染进程时去问媒体查询，常常还能问出上一档的值（表现：按钮文字变了，界面没变）。
 * 所以浅色/深色两档直接用设置里的值落定，只有「跟随系统」才需要问媒体查询。
 *
 * HTML 里的内联脚本负责首次赋值（放在样式表之前，避免闪一帧浅色）；
 * 这里负责之后的变化：改了外观不重启也得立刻生效。
 */

/** 最后一次应用过的档位 —— 「跟随系统」时系统自己变天要靠它重算 */
let mode: ThemeMode = 'system'

export function applyTheme(next: ThemeMode = mode): void {
  mode = next
  try {
    const dark =
      next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  } catch {
    /* 拿不到就保持原样，界面不会因此不可用 */
  }
}

export function watchSystemTheme(): void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    // 只认「系统自己变天」这条路；设置改动走 applyTheme(mode)，不等事件
    query.addEventListener('change', () => applyTheme())
    applyTheme()
  } catch {
    /* 拿不到就保持内联脚本写下的那一档，界面不会因此不可用 */
  }
}
