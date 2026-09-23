/** 数字与时间格式化 —— 主进程、渲染层、测试脚本共用 */

import type { SourceKind } from './types'

/** 12345678 -> 12.3M；1234 -> 1.23K */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}K`
  return String(Math.round(value))
}

function trim(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toFixed(digits).replace(/\.0+$/, '')
}

/** 千分位：1234567 -> 1,234,567 */
export function grouped(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('en-US')
}

/** 百分比，0..100，保留一位小数 */
export function percent(part: number, whole: number): number {
  if (!whole) return 0
  return Math.round((part / whole) * 1000) / 10
}

/** 积分保留两位，去掉多余的 0 */
export function credits(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(2).replace(/\.?0+$/, '') || '0'
}

/**
 * 该数据源是否按积分计量。
 * 只有 WorkBuddy 有积分这一层，Kimi Code 与 ZCode 都没有 —— 所有积分相关的
 * 数字、比价、提示都要整块收起来，显示成 0 分比不显示更糟。
 */
export function hasCredits(kind: SourceKind): boolean {
  return kind === 'workbuddy'
}

/**
 * 该数据源是否单列思考 token。
 * WorkBuddy 与 ZCode 都单列；Kimi Code 的 output 里已含思考，没有这一项，
 * 留着只会永远是一根 0 长度的空条。
 */
export function hasReasoning(kind: SourceKind): boolean {
  return kind === 'workbuddy' || kind === 'zcode'
}

/** 数据源在界面上的顺序 —— 面板分段按钮与托盘菜单共用同一份，免得两边点错位 */
export const SOURCE_ORDER: SourceKind[] = ['workbuddy', 'kimi', 'zcode']

/** 数据源显示名 */
export function sourceLabel(kind: SourceKind): string {
  if (kind === 'workbuddy') return 'WorkBuddy'
  if (kind === 'zcode') return 'ZCode'
  return 'Kimi Code'
}

/**
 * 上下文水位的一句话摘要。
 * 窗口未知时（size = 0，比如 ZCode 走远程 provider、模型目录不落本地）
 * 只报已用量，不要凭空编一个百分比出来。
 */
export function contextSummary(active: { used: number; size: number } | null): string {
  if (!active) return '无活跃会话'
  if (active.size > 0) return `上下文 ${percent(active.used, active.size)}%`
  return `上下文 ${compact(active.used)} token`
}

/** token 与积分的比价：1 积分约等于多少 token */
export function tokenPerCredit(tokens: number, credit: number): string {
  if (!credit || credit <= 0) return '—'
  const rate = tokens / credit
  if (rate >= 1_000_000) return `${trim(rate / 1_000_000)}M`
  if (rate >= 1_000) return `${trim(rate / 1_000)}K`
  return String(Math.round(rate))
}

export function formatClock(timestamp: number): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDateTime(timestamp: number): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：3 分钟前 */
export function relativeTime(timestamp: number, now: number): string {
  if (!timestamp) return '—'
  const diff = Math.max(0, now - timestamp)
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  const days = Math.floor(diff / (24 * 60 * minute))
  if (days < 30) return `${days} 天前`
  return formatDateTime(timestamp).slice(0, 10)
}

/** 会话目录名 -> 可读项目名（cwd 拿不到时的兜底） */
export function projectLabel(projectDir: string, cwd: string): string {
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  const stripped = projectDir.replace(/^[a-zA-Z]-/, '')
  const parts = stripped.split('-').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : projectDir
}

/* --------------------------------------------------------- 日期网格工具 */

/** 本地时区的日期键 YYYY-MM-DD，与 collector 的 localDate 同口径 */
export function dayKeyOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 加减天数，返回新 Date（不修改入参）。归一到当天 0 点，避开夏令时跨天误差 */
export function shiftDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

/** 今天 0 点 */
export function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}
