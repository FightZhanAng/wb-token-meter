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

/** 按当前 prefers-color-scheme 重写 data-theme。供「设置变了」的那条路显式调用。 */
export function applySystemTheme(): void {
  try {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  } catch {
    /* 拿不到就保持原样，界面不会因此不可用 */
  }
}

export function watchSystemTheme(): void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    /*
     * 只靠 change 事件不够：Electron 改 themeSource 之后，有的版本更新了
     * prefers-color-scheme 却不派发 MediaQueryList 的 change —— 表现就是
     * 「点外观按钮，按钮文字变了，界面颜色没变」。所以 App 收到设置广播时
     * 会再显式调一次 applySystemTheme()，这里只负责系统自己变的那条路。
     */
    query.addEventListener('change', applySystemTheme)
    applySystemTheme()
  } catch {
    /* 拿不到就保持内联脚本写下的那一档，界面不会因此不可用 */
  }
}
