/**
 * Trae CN 云端「积分」（权益额度）的纯逻辑 —— 响应解析与文案。
 * 不碰文件系统、不发请求，主进程与无头自检（scripts/core-test.ts）都能直接调。
 *
 * 为什么要走云端：本地那本 SQLCipher 账（shared/traecn-collector.ts）记的是
 * 「这次调用花了多少 token」，**没有积分这一层** —— 权益包、余额、已消耗全是
 * 服务端才算得出来的。所以积分只能联网查，它和本地 token 账是两条独立的链路，
 * 谁读不到都不该把对方拖成 0。
 *
 * 用 v2 而不是 v1：`v1/pay/user_current_entitlement_list` 同样返回 200，
 * 但响应里**没有 usage_summary**（只有按次数的额度），拿不到「已用 / 总额」。
 * 只有 v2 带回 usage_summary.{consumed_amount, total_amount, consumption_ratio}。
 *
 * 凭证不是文件：磁盘上的 `%USERPROFILE%\.trae-cn\trae-jwt-token` 是过期的
 * CLI token，恒 401。有效的那支 JWT 只活在 Trae CN 进程内存里 —— 捞它见
 * main/traecn-key.ts，而**验证手段就是打这个接口**：200 才算这支有效。
 */

/** 官方端点。测试时用 WB_TOKEN_METER_TRAECN_CREDITS_URL 指到本地 mock */
export const DEFAULT_CREDITS_ENDPOINT =
  'https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list'

/** 一个额度包（同一 display_desc 的若干条已经合并成一条） */
export interface CreditPack {
  desc: string
  /** 这一类额度包加起来的上限 */
  limit: number
}

export interface ParsedCredits {
  /** 已消耗积分 */
  consumed: number
  /** 总积分额度（来自 usage_summary.total_amount） */
  total: number
  /** 已用比例 0..1 */
  ratio: number
  /** 额度包明细，按上限从大到小 */
  packs: CreditPack[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析 v2 权益接口的响应体。
 *
 * 判据是 usage_summary：它不在就说明打到了别的接口（比如 v1）或响应换版了，
 * 返回 null 让调用方把这张卡画成「读不到」，而不是拿 0 冒充余额。
 * 其余字段（包列表）缺失只让明细变空，不影响那个「已用 / 总额」的主数字。
 */
export function parseCreditsResponse(raw: unknown): ParsedCredits | null {
  const root = asRecord(raw)
  const summary = asRecord(root?.['usage_summary'])
  const consumed = numberOf(summary?.['consumed_amount'])
  const total = numberOf(summary?.['total_amount'])
  if (consumed === null && total === null) return null

  const consumedValue = Math.max(0, consumed ?? 0)
  const totalValue = Math.max(0, total ?? 0)
  const reported = numberOf(summary?.['consumption_ratio'])
  // 服务端给的比例优先，但只认 0..1 这个区间：它要是越界（换了口径 / 字段被复用），
  // 宁可退回自己按 已用÷总额 算，也别让进度条画出 >100% 或负数。
  const ratio =
    reported !== null && reported >= 0 && reported <= 1
      ? reported
      : totalValue > 0
        ? Math.min(1, consumedValue / totalValue)
        : 0

  return { consumed: consumedValue, total: totalValue, ratio, packs: parsePacks(root?.['user_entitlement_pack_list']) }
}

/**
 * 额度包摊平。
 *
 * 同一个 display_desc 会重复出现好几条（「签到奖励」实测 9 条，一天一条），
 * 逐条列出来界面就成了流水账 —— 按 desc 合并、上限求和，只报「这一类一共给了多少」。
 *
 * 没有 credits_limit 的包（实测「免费」那条只有 enable_* 开关）直接跳过：
 * 它不是积分包，把它按 0 收进来只会让明细里多一行没有数字的条目。
 */
function parsePacks(raw: unknown): CreditPack[] {
  if (!Array.isArray(raw)) return []
  const merged = new Map<string, number>()
  for (const item of raw) {
    const pack = asRecord(item)
    const desc = typeof pack?.['display_desc'] === 'string' ? (pack['display_desc'] as string) : ''
    // 包的上限两层都见过：entitlement_base_info.quota 是常规位置，
    // 顶层 quota 作兜底 —— 少了它顶多漏一个包，不该让整张明细塌掉。
    const quota =
      asRecord(asRecord(pack?.['entitlement_base_info'])?.['quota']) ?? asRecord(pack?.['quota'])
    const limit = numberOf(quota?.['credits_limit'])
    if (!desc || limit === null || limit <= 0) continue
    merged.set(desc, (merged.get(desc) ?? 0) + limit)
  }
  return [...merged.entries()]
    .map(([desc, limit]) => ({ desc, limit }))
    .sort((a, b) => b.limit - a.limit)
}

/**
 * HTTP 状态 -> 人话。
 * 401/403 单独说清楚：那是凭证的事，跟网络无关，用户该去 Trae CN 里重新登录，
 * 而不是去查自己的网。
 */
export function describeCreditsHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Trae CN 的登录凭证已失效，请在 Trae CN 里重新登录（重启本工具后重新取一次）'
  }
  return `积分接口返回 HTTP ${status}`
}

/**
 * 积分卡上那行明细：`老用户福利 4000 · 每月登录赠送 500`。
 * 空数组返回空串，调用方据此决定要不要渲染这一行。
 */
export function describeCreditPacks(packs: CreditPack[]): string {
  return packs.map((pack) => `${pack.desc} ${pack.limit}`).join(' · ')
}
