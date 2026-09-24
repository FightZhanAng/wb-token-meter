/**
 * OpenCode Go 额度接口的纯逻辑 —— 响应解析、归一、文案。
 * 不碰文件系统也不发请求，主进程与无头测试都能直接调。
 */

import type { QuotaWindow, QuotaWindowKey, UsageSample } from './types'

/** 官方端点。测试时用 WB_TOKEN_METER_OPENCODE_URL 指到本地 mock */
export const DEFAULT_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** 窗口顺序 —— 面板、托盘、胶囊共用这一份 */
export const QUOTA_WINDOW_ORDER: QuotaWindowKey[] = ['rolling', 'weekly', 'monthly']

/** 窗口显示名 */
export function quotaWindowLabel(key: QuotaWindowKey): string {
  if (key === 'rolling') return '5 小时'
  if (key === 'weekly') return '本周'
  return '本月'
}

/** 窗口短名，托盘摘要一行放得下 */
export function quotaWindowShort(key: QuotaWindowKey): string {
  if (key === 'rolling') return '5h'
  if (key === 'weekly') return '周'
  return '月'
}

/** 占用等级 —— 与胶囊圆环共用一套配色语义 */
export function quotaLevel(percentValue: number): 'ok' | 'warn' | 'danger' {
  if (percentValue >= 90) return 'danger'
  if (percentValue >= 70) return 'warn'
  return 'ok'
}

/** 把服务端给的比例收进 0..100；不是数字就当这条窗口没有 */
function normalizePercent(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.min(100, Math.max(0, Math.round(raw)))
}

/** ISO 串 -> 毫秒时间戳；认不出来给 0，界面会显示成「重置时间未知」 */
export function parseTime(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : 0
}

/**
 * 解析 /zen/go/v1/usage 的响应体。
 * 只认 usage 下的三个窗口，缺哪个跳哪个 —— 服务端加窗口或改字段，
 * 都不该让整块显示不出来。
 */
export function parseUsageResponse(raw: unknown): QuotaWindow[] {
  const usage = (raw as { usage?: unknown } | null | undefined)?.usage
  if (!usage || typeof usage !== 'object') return []
  const source = usage as Record<string, unknown>
  const windows: QuotaWindow[] = []
  for (const key of QUOTA_WINDOW_ORDER) {
    const item = source[key]
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const percent = normalizePercent(entry.percent)
    if (percent === null) continue
    windows.push({
      key,
      percent,
      status: typeof entry.status === 'string' ? entry.status : 'ok',
      resetsAt: parseTime(entry.resetsAt)
    })
  }
  return windows
}

/** 重置时间文案：'3 小时后重置' / '9-28 08:00 重置' */
export function describeReset(resetsAt: number, now: number): string {
  if (!resetsAt) return '重置时间未知'
  const diff = resetsAt - now
  if (diff <= 0) return '即将重置'
  const minute = 60_000
  if (diff < 60 * minute) return `${Math.max(1, Math.round(diff / minute))} 分钟后重置`
  if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} 小时后重置`
  const d = new Date(resetsAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 重置`
}

/** 三个窗口的一句话摘要，托盘 tooltip 与胶囊副行共用 */
export function quotaSummary(windows: QuotaWindow[], style: 'short' | 'long' = 'short'): string {
  if (!windows.length) return '额度未知'
  return windows
    .map((w) => {
      const label = style === 'short' ? quotaWindowShort(w.key) : quotaWindowLabel(w.key)
      return `${label} ${w.percent}%`
    })
    .join(' · ')
}

/** 某个窗口的占用；没有这条窗口时返回 null */
export function windowOf(windows: QuotaWindow[], key: QuotaWindowKey): QuotaWindow | null {
  return windows.find((w) => w.key === key) ?? null
}

/** 采样点取最近 N 天；点数超过上限时按时间等距抽稀（末点一定保留） */
export function recentSamples(
  samples: UsageSample[],
  now: number,
  days: number,
  maxPoints: number
): UsageSample[] {
  const since = now - days * 24 * 60 * 60_000
  const kept = samples.filter((s) => s.t >= since)
  if (maxPoints <= 0 || kept.length <= maxPoints) return kept
  const step = Math.ceil(kept.length / maxPoints)
  const thinned = kept.filter((_, index) => index % step === 0)
  const last = kept[kept.length - 1]
  if (thinned[thinned.length - 1] !== last) thinned.push(last)
  return thinned
}
