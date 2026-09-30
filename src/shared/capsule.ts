/**
 * 桌面胶囊的主题 —— 与面板的「外观」是**两条独立的轴**。
 *
 * 面板走 nativeTheme.themeSource（跟随系统 / 浅色 / 深色），一次管到底；
 * 胶囊不行：它是贴在别人桌面上的一块独立牌子，用户经常想让它跟面板不一样
 * （面板深色、胶囊留一张白纸；或者反过来，晚上只把胶囊调成琥珀夜光）。
 * 一块牌子的换装成本很低，多给几档风格反而合理，所以这里自己一份设置。
 *
 * 令牌本体在 float.css 的 `:root[data-capsule='…']` 块里；这个文件只放
 * **两端都要用**的东西：显示名、顺序，以及实心底色模式下的窗口底色
 * —— 那是创建参数，CSS 够不着，只能主进程给。
 */
import type { CapsuleTheme } from './types'

/** 菜单与循环按钮的顺序：跟随面板排最前，其余由浅到深，最后是唯一没色相的碳黑 */
export const CAPSULE_THEME_ORDER: CapsuleTheme[] = ['auto', 'paper', 'ink', 'amber', 'carbon']

const LABELS: Record<CapsuleTheme, string> = {
  auto: '跟随面板',
  paper: '记录纸',
  ink: '深靛',
  amber: '琥珀夜光',
  carbon: '碳黑'
}

/** 托盘菜单里用全名 */
export function capsuleThemeLabel(theme: CapsuleTheme): string {
  return LABELS[theme]
}

/**
 * 卡片头部那个按钮里塞得下的短名。
 *
 * 单独写一张表，不靠 `LABELS[theme].slice(0, 2)` —— 那样「记录纸」会变成
 * 「记录」，在按钮上紧挨着一个色块看，更像动词。
 */
const SHORT: Record<CapsuleTheme, string> = {
  auto: '面板',
  paper: '纸',
  ink: '深靛',
  amber: '琥珀',
  carbon: '碳黑'
}

export function capsuleThemeShort(theme: CapsuleTheme): string {
  return SHORT[theme]
}

/**
 * 实心底色模式下窗口自己的底色（= 各主题的 `--sheet`）。
 *
 * 窗口底色是创建参数，只能在主进程给；而胶囊本体是 CSS 画的。两边对不上的表现
 * 是「胶囊四周多出一圈异色」—— 透明模式下看不出来，一旦切到实心底色就露馅。
 * 所以这张表必须和 float.css 里同名主题的 `--sheet` 逐字节相同，core-test 会去对。
 */
export const CAPSULE_SOLID_BG: Record<Exclude<CapsuleTheme, 'auto'>, string> = {
  paper: '#F6F8F5',
  ink: '#111726',
  amber: '#12100B',
  carbon: '#141618'
}

/**
 * `auto` 解析成具体主题 —— 「跟随面板」在页面里就表现为 prefers-color-scheme
 * （主进程把面板那一档写进了 nativeTheme.themeSource）。
 * 解析出来的是 paper / ink 之一，这样 CSS 里不用为 auto 再抄一份令牌。
 */
export function resolveCapsuleTheme(theme: CapsuleTheme, dark: boolean): Exclude<CapsuleTheme, 'auto'> {
  if (theme === 'auto') return dark ? 'ink' : 'paper'
  return theme
}

export function capsuleSolidBackground(theme: CapsuleTheme, dark: boolean): string {
  return CAPSULE_SOLID_BG[resolveCapsuleTheme(theme, dark)]
}
