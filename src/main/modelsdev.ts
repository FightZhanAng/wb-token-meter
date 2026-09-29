import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseModelsDevContextSizes } from '../shared/zcode-collector'

/** 目录新鲜期：之内不发请求。模型目录一天长一个新模型，一天拉一次足够了 */
const REFRESH_AFTER_MS = 24 * 60 * 60_000
/** 失败退避：翻倍增长，到顶为止 */
const BACKOFF_BASE_MS = 10 * 60_000
const BACKOFF_MAX_MS = 2 * 60 * 60_000
/** 单次请求超时 —— 目录有好几 MB，比额度接口放宽些 */
const TIMEOUT_MS = 20_000

export const DEFAULT_MODELSDEV_ENDPOINT = 'https://models.dev/api.json'

export interface ModelsDevCatalogOptions {
  /** 提炼结果的落地文件（main 放在 userData 下） */
  cacheFile: string
  /** 端点覆盖，测试用 */
  endpoint?: string
  now?: () => number
  fetchImpl?: typeof fetch
}

/**
 * models.dev 公共模型目录的后台客户端。
 *
 * ZCode 自家的模型目录只对本地 provider 落盘（config.json），远程 provider
 * （opencode-go 系）的上下文窗口只能从这份公共目录兜底。职责与 OpencodeUsage
 * 同款：in-flight 去重、新鲜期内不重复拉、失败指数退避，而且网络动作全在
 * 后台，绝不阻塞 20 秒一次的同步轮询。
 *
 * 新鲜期看的是缓存文件里自己写的 fetchedAt 而不是 mtime —— 前者跟着注入
 * 的时钟走（测试要推进时间），后者永远是真实的墙钟，混着比必然出错。
 */
export class ModelsDevCatalog {
  /** 提炼缓存路径 —— 主进程传给采集器用 */
  readonly cacheFile: string
  private readonly endpoint: string
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  private lastAttemptAt = 0
  private backoffMs = 0
  private inFlight: Promise<boolean> | null = null

  constructor(options: ModelsDevCatalogOptions) {
    this.cacheFile = options.cacheFile
    this.endpoint = options.endpoint || DEFAULT_MODELSDEV_ENDPOINT
    this.now = options.now ?? ((): number => Date.now())
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 需要时拉一次目录并落地。返回 true 表示这次真的更新了缓存文件，
   * 调用方据此决定要不要重采 —— 也避免「拉取完成 -> 重采 -> 又触发拉取」
   * 绕成死循环：重采后的下一次 pull 会因为目录还新鲜而直接返回 false。
   */
  pull(force = false): Promise<boolean> {
    if (this.inFlight) return this.inFlight
    const task = this.run(force).finally(() => {
      if (this.inFlight === task) this.inFlight = null
    })
    this.inFlight = task
    return task
  }

  /** 缓存里自己落的 fetchedAt；文件缺失或读坏了当 0（视为过期） */
  private cacheFetchedAt(): number {
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as { fetchedAt?: unknown }
      const at = raw.fetchedAt
      return typeof at === 'number' && Number.isFinite(at) ? at : 0
    } catch {
      return 0
    }
  }

  private async run(force: boolean): Promise<boolean> {
    const startedAt = this.now()
    if (!force) {
      if (startedAt - this.cacheFetchedAt() < REFRESH_AFTER_MS) return false
      // 退避期内不重试；backoffMs 为 0 时这个条件恒假，不影响首次拉取
      if (startedAt < this.lastAttemptAt + this.backoffMs) return false
    }
    this.lastAttemptAt = startedAt

    try {
      const response = await this.fetchImpl(this.endpoint, {
        headers: { 'user-agent': 'wb-token-meter' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`)
      const sizes = parseModelsDevContextSizes(await response.text())
      if (!sizes.size) throw new Error('目录里没有可用的模型窗口')
      this.writeCache(sizes, this.now())
      this.backoffMs = 0
      return true
    } catch {
      this.backoffMs = this.backoffMs ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_BASE_MS
      return false
    }
  }

  /** 先写临时文件再原子改名：采集器随时可能在读，不能让它读到半个 JSON */
  private writeCache(sizes: Map<string, number>, fetchedAt: number): void {
    const tmp = `${this.cacheFile}.${process.pid}.tmp`
    mkdirSync(dirname(this.cacheFile), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ fetchedAt, sizes: Object.fromEntries(sizes) }), 'utf8')
    renameSync(tmp, this.cacheFile)
  }
}
