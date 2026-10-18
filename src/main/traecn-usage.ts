/**
 * Trae CN 云端积分的客户端 —— 与 OpenCode Go 的额度源是同一路数（见
 * main/opencode-usage.ts）：数据不在本地，得发 HTTPS 请求。所以同样要自己管住
 * 三件事 —— 别并发打接口（in-flight 去重）、别太频繁（最小间隔）、失败别死循环
 * （指数退避）。网络动作全在后台，绝不阻塞 20 秒一次的同步轮询。
 *
 * 与 OpenCode 那支最大的不同是**凭证的来路**：那边从磁盘 auth.json 读，这边
 * 只能从 Trae CN 进程内存里捞（main/traecn-key.ts 顺带把 JWT 一起扫出来，
 * 省得为两支凭证把 680MB 内存扫两遍）。捞到的是候选 —— 内存里有副本、末尾偶尔
 * 还会多粘几个字符，所以**每支都得打一次接口验**：200 才算数，401 就换下一支。
 *
 * 那支验通过之后缓存在内存里（`private token`），**绝不落盘、绝不进日志** ——
 * 它是一次登录会话的凭据，写出去等于把账号交出去。Trae CN 重启会换 JWT，
 * 那时数据库密钥也一起换（两者锁在同一个进程内存里），traecn 那边的重扫会把
 * 候选一起刷新，所以这里不需要自己再触发扫描。
 */
import {
  DEFAULT_CREDITS_ENDPOINT,
  describeCreditsHttpError,
  parseCreditsResponse,
  type ParsedCredits
} from '../shared/traecn-credits'

/** 自动拉取的最小间隔：轮询是 20 秒一次，但网络请求不该这么密 */
const MIN_INTERVAL_MS = 60_000
/** 失败退避：翻倍增长，到顶为止 */
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 300_000
/** 单次请求超时 */
const TIMEOUT_MS = 8_000
/**
 * 一次扫描最多验几支候选 —— 每支一次请求。
 *
 * 上限给得比较宽（实测一次能捞到三四十支，因为同一支 token 在内存里有副本、
 * 尾巴还会被正则多吃几个字符），但**正常情况只会打前一两支**：候选是按长度升序
 * 排的（见 traecn-key.ts），真身一定是那一族里最短的。所以这个上限只在
 * 「排在前面的都不是那支对的」这种病态情况下才起作用，用来兜住别把接口打爆。
 * 验通过之后就一直用缓存的那支，不会再付这份钱。
 */
const MAX_CANDIDATES = 40

export interface TraeCnUsageOptions {
  /** 端点覆盖，测试用 */
  endpoint?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

/** 当前状态：可能来自缓存，也可能是失败后留下的陈旧值 */
export interface TraeCnUsageState {
  data: ParsedCredits | null
  fetchedAt: number
  stale: boolean
  error: string | null
}

export class TraeCnUsage {
  readonly endpoint: string

  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  private state: TraeCnUsageState = { data: null, fetchedAt: 0, stale: false, error: null }
  /** 已验通过的那支 JWT，只在内存里 */
  private token: string | null = null
  private lastAttemptAt = 0
  private backoffMs = 0
  private inFlight: Promise<boolean> | null = null

  constructor(options: TraeCnUsageOptions) {
    this.endpoint = options.endpoint || DEFAULT_CREDITS_ENDPOINT
    this.now = options.now ?? ((): number => Date.now())
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  current(): TraeCnUsageState {
    return this.state
  }

  /** 凭证描述：只说「从哪来的」，不带任何 token 内容 */
  credentialLabel(): string {
    return this.token ? 'Trae CN 进程内存里的登录凭证' : '尚未取到 Trae CN 登录凭证'
  }

  /**
   * 拉一次积分。返回 true 表示这次真的发了请求并拿到了结果。
   * 命中节流、正在退避、已有请求在飞时返回 false —— 调用方据此决定要不要重绘，
   * 也避免「拉取完成 -> 重绘 -> 又触发拉取」绕成死循环。
   *
   * @param candidates 内存里捞到的候选 JWT；只在还没验通过时用得上
   */
  pull(candidates: string[], force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight
    const task = this.run(candidates, force).finally(() => {
      if (this.inFlight === task) this.inFlight = null
    })
    this.inFlight = task
    return task
  }

  private async run(candidates: string[], force: boolean): Promise<boolean> {
    const startedAt = this.now()
    if (!force) {
      if (startedAt - this.lastAttemptAt < MIN_INTERVAL_MS) return false
      if (startedAt < this.lastAttemptAt + this.backoffMs) return false
    }

    // 已经验通过的就直接用；没有才去逐个试候选。内存里同一支 token 会有副本、
    // 还可能被正则多吃了几个尾部字符 —— 这些长得几乎一样，只有打接口才分得出来。
    const list = this.token ? [this.token] : candidates.slice(0, MAX_CANDIDATES).filter(Boolean)
    if (!list.length) {
      // 没候选就是「还没得验」，**不是失败** —— 这一轮压根没发请求。所以不设退避：
      // 硬退 5 分钟会让「Trae CN 稍后才起来」变成「6 分钟后才有积分」，而重扫一轮
      // 要半分钟，加起来就太难等了。只走那个 60 秒最小间隔，足够拦住空转。
      this.lastAttemptAt = startedAt
      this.state = {
        ...this.state,
        stale: this.state.fetchedAt > 0,
        error: '没取到 Trae CN 的登录凭证（Trae CN 没在运行？），积分读不到'
      }
      return false
    }

    this.lastAttemptAt = startedAt
    let lastError = ''
    let sawAuthFailure = false
    for (const token of list) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Cloud-IDE-JWT ${token}`,
            'content-type': 'application/json',
            'user-agent': 'wb-token-meter'
          },
          body: '{}',
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
        if (response.status === 401 || response.status === 403) {
          // 这一支不被认账 —— 换下一支。全试完都不行才算「凭证失效」。
          sawAuthFailure = true
          lastError = describeCreditsHttpError(response.status)
          continue
        }
        if (!response.ok) throw new Error(describeCreditsHttpError(response.status))
        const data = parseCreditsResponse(await response.json())
        if (!data) throw new Error('响应里没有 usage_summary，取不到积分汇总')
        this.token = token
        this.state = { data, fetchedAt: this.now(), stale: false, error: null }
        this.backoffMs = 0
        return true
      } catch (error) {
        // 网络错误 / 超时与「这支队不对」是两回事：继续拿剩下几支去打只会
        // 把一次超时放大成八次，所以立刻停手，退避下一轮再说。
        lastError = describeError(error)
        break
      }
    }

    // 全部候选都是 401（或网络错误）：作废缓存的那支，下轮从候选重来；
    // 若这批候选本身也过期了，就得等 Trae CN 重启带动重扫（见文件头说明）。
    if (sawAuthFailure) this.token = null
    this.state = { ...this.state, stale: this.state.fetchedAt > 0, error: lastError || '取不到积分' }
    this.backoffMs = this.backoffMs ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_BASE_MS
    return false
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时'
    return error.message || '请求失败'
  }
  return String(error)
}
