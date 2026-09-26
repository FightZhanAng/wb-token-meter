/**
 * 把 `<html data-theme>` 和系统的 `prefers-color-scheme` 绑在一起。
 *
 * 外观最终由主进程的 `nativeTheme.themeSource` 决定（跟随系统 / 浅色 / 深色），
 * 它在页面里就表现为 prefers-color-scheme —— 所以 CSS 只需要认这一个信号，
 * 不必再走一套 IPC 把「现在是什么主题」传进来。
 *
 * HTML 里的内联脚本负责首次赋值（放在样式表之前，避免闪一帧浅色）；
 * 这里负责之后的变化：改了外观不重启也得立刻生效。
 */
export function watchSystemTheme(): void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = query.matches ? 'dark' : 'light'
    }
    query.addEventListener('change', apply)
    apply()
  } catch {
    /* 拿不到就保持内联脚本写下的那一档，界面不会因此不可用 */
  }
}
