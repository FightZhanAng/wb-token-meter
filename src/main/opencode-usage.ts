import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_USAGE_ENDPOINT, parseUsageResponse, recentSamples } from '../shared/opencode-quota'
import type { QuotaWindow, QuotaWindowKey, UsageSample } from '../shared/types'

/** 自动拉取的最小间隔：轮询是 20 秒一次，但网络请求不该这么密 */
const MIN_INTERVAL_MS = 60_000
/** 失败退避：翻倍增长，到顶为止 */
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 300_000
/** 单次请求超时 */
const TIMEOUT_MS = 8_000
/** 采样心跳：额度一直没变也要留个点，趋势图才不断档 */
const HEARTBEAT_MS = 30 * 60_000
/** 采样保留期 */
const KEEP_DAYS = 30
/** 采样文件超过这个条数就整体重写一次，别让它无限长 */
const MAX_SAMPLES = 20_000
/** 送给界面的采样点数上限 */
const HISTORY_POINTS = 400

export interface OpencodeUsageOptions {
  /** opencode 数据目录，auth.json 在这里 */
  dir: string
  /** 采样历史文件（jsonl） */
  historyFile: string
  /** 端点覆盖，测试用 */
  endpoint?: string
  /** 直接给密钥，测试用；给了就不读 auth.json */
  keyOverride?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

/** 当前额度状态：可能来自缓存，也可能是失败后留下的陈旧值 */
export interface OpencodeUsageState {
  windows: QuotaWindow[]
  fetchedAt: number
  stale: boolean
  error: string | null
}

/**
 * OpenCode Go 额度客户端。
 *
 * 与另外四个源最大的不同：数据不在本地，得发 HTTPS 请求。所以这一块必须自己管住
 * 三件事 —— 别并发打接口（in-flight 去重）、别太频繁（最小间隔）、失败别死循环
 * （指数退避）。而且网络动作全在后台，绝不阻塞 20 秒一次的同步轮询。
 */
export class OpencodeUsage {
  private readonly dir: string
  private readonly historyFile: string
  private readonly keyOverride: string | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  readonly endpoint: string

  private state: OpencodeUsageState = { windows: [], fetchedAt: 0, stale: false, error: null }
  private samples: UsageSample[] = []
  private samplesLoaded = false
  private lastAttemptAt = 0
  private backoffMs = 0
  private inFlight: Promise<boolean> | null = null

  constructor(options: OpencodeUsageOptions) {
    this.dir = options.dir
    this.historyFile = options.historyFile
    this.endpoint = options.endpoint || DEFAULT_USAGE_ENDPOINT
    this.keyOverride = options.keyOverride
    this.now = options.now ?? ((): number => Date.now())
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  current(): OpencodeUsageState {
    return this.state
  }

  /** 凭证文件路径 —— 出错提示里要用到 */
  get credentialFile(): string {
    return join(this.dir, 'auth.json')
  }

  /** 凭证描述：只说明「从哪读的」，不带任何密钥内容 */
  credentialLabel(): string {
    if (this.keyOverride) return '环境变量 WB_TOKEN_METER_OPENCODE_KEY'
    return this.credentialFile
  }

  /**
   * 拉一次额度。返回 true 表示这次真的发了请求并拿到了结果。
   * 命中节流、正在退避、已有请求在飞时返回 false —— 调用方据此决定要不要重绘，
   * 也避免「拉取完成 -> 重绘 -> 又触发拉取」绕成死循环。
   */
  pull(force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight
    const task = this.run(force).finally(() => {
      if (this.inFlight === task) this.inFlight = null
    })
    this.inFlight = task
    return task
  }

  /** 送给界面的采样点：最近 7 天，点数过多时抽稀 */
  history(): UsageSample[] {
    this.loadSamples()
    return recentSamples(this.samples, this.now(), 7, HISTORY_POINTS)
  }

  private async run(force: boolean): Promise<boolean> {
    const startedAt = this.now()
    if (!force) {
      if (startedAt - this.lastAttemptAt < MIN_INTERVAL_MS) return false
      if (startedAt < this.lastAttemptAt + this.backoffMs) return false
    }

    const key = this.readKey()
    if (!key) {
      this.lastAttemptAt = startedAt
      this.backoffMs = BACKOFF_MAX_MS
      this.state = {
        ...this.state,
        stale: this.state.fetchedAt > 0,
        error: `未找到 OpenCode Go 凭证：${this.credentialFile}`
      }
      return false
    }

    this.lastAttemptAt = startedAt
    try {
      const response = await this.fetchImpl(this.endpoint, {
        headers: { authorization: `Bearer ${key}`, 'user-agent': 'wb-token-meter' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(describeHttpError(response.status))
      const windows = parseUsageResponse(await response.json())
      if (!windows.length) throw new Error('响应里没有可用的额度窗口')
      const finishedAt = this.now()
      this.state = { windows, fetchedAt: finishedAt, stale: false, error: null }
      this.backoffMs = 0
      this.recordSample(windows, finishedAt)
      return true
    } catch (error) {
      this.state = { ...this.state, stale: this.state.fetchedAt > 0, error: describeError(error) }
      this.backoffMs = this.backoffMs ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_BASE_MS
      return false
    }
  }

  /** 采样：值变了就记一条，没变也每半小时留个心跳 */
  private recordSample(windows: QuotaWindow[], now: number): void {
    const point: UsageSample = {
      t: now,
      rolling: windowPercent(windows, 'rolling'),
      weekly: windowPercent(windows, 'weekly'),
      monthly: windowPercent(windows, 'monthly')
    }
    this.loadSamples()
    const last = this.samples[this.samples.length - 1]
    const unchanged =
      last && last.rolling === point.rolling && last.weekly === point.weekly && last.monthly === point.monthly
    if (unchanged && now - last.t < HEARTBEAT_MS) return

    this.samples.push(point)
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = recentSamples(this.samples, now, KEEP_DAYS, MAX_SAMPLES)
      this.writeSamples()
      return
    }
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true })
      appendFileSync(this.historyFile, `${JSON.stringify(point)}\n`, 'utf-8')
    } catch {
      // 采样写不进去不影响额度显示
    }
  }

  private loadSamples(): void {
    if (this.samplesLoaded) return
    this.samplesLoaded = true
    try {
      if (!existsSync(this.historyFile)) return
      const kept: UsageSample[] = []
      for (const line of readFileSync(this.historyFile, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        const parsed = parseSample(line)
        if (parsed) kept.push(parsed)
      }
      const fresh = recentSamples(kept, this.now(), KEEP_DAYS, 0)
      this.samples = fresh
      // 顺手做一次保留期清理，有东西过期就整体重写
      if (fresh.length !== kept.length) this.writeSamples()
    } catch {
      this.samples = []
    }
  }

  private writeSamples(): void {
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true })
      const body = this.samples.map((sample) => JSON.stringify(sample)).join('\n')
      writeFileSync(this.historyFile, body ? `${body}\n` : '', 'utf-8')
    } catch {
      // 同上，落盘失败不影响主流程
    }
  }

  /** 从 auth.json 里取 opencode-go 的密钥；读不到返回 null */
  private readKey(): string | null {
    if (this.keyOverride) return this.keyOverride
    try {
      const raw = JSON.parse(readFileSync(this.credentialFile, 'utf-8')) as Record<string, unknown>
      const entry = raw['opencode-go'] as { key?: unknown } | undefined
      const key = entry?.key
      return typeof key === 'string' && key.trim() ? key.trim() : null
    } catch {
      return null
    }
  }
}

function windowPercent(windows: QuotaWindow[], key: QuotaWindowKey): number {
  return windows.find((w) => w.key === key)?.percent ?? 0
}

function parseSample(line: string): UsageSample | null {
  try {
    const raw = JSON.parse(line) as Partial<UsageSample>
    if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) return null
    return { t: raw.t, rolling: count(raw.rolling), weekly: count(raw.weekly), monthly: count(raw.monthly) }
  } catch {
    return null
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 401/403 单独说清楚，用户才知道该去重连而不是查网络 */
function describeHttpError(status: number): string {
  if (status === 401 || status === 403) return '凭证失效，请在 opencode 里重新连接 OpenCode Go'
  return `额度接口返回 HTTP ${status}`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时'
    return error.message || '请求失败'
  }
  return String(error)
}
