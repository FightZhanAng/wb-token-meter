/** 共享类型定义 —— 主进程与渲染层都用这一份 */

/** 一次模型调用的用量记录 */
export interface CallRecord {
  traceId: string
  /**
   * 计费键。workbuddy.db 的 credit_json 以它为 key；
   * 老版本 WorkBuddy 里它和 traceId 同值，新版本两者分离 ——
   * 只认 traceId 会导致新会话的积分全是 0。
   * 见 collector.ts 的 billingKey()。
   */
  conversationRequestId: string
  sessionId: string
  projectDir: string
  model: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

export interface TokenBundle {
  calls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
}

export interface SessionStat extends TokenBundle {
  sessionId: string
  title: string
  cwd: string
  projectDir: string
  model: string
  status: string
  credits: number
  totalTraces: number
  matchedTraces: number
  contextUsed: number
  contextSize: number
  lastActivity: number
}

export interface DayStat extends TokenBundle {
  date: string
  credits: number
}

export interface ModelStat extends TokenBundle {
  model: string
  credits: number
  sessions: number
}

export interface ProjectStat extends TokenBundle {
  projectDir: string
  cwd: string
  sessions: number
}

export interface ActiveContext {
  sessionId: string
  title: string
  cwd: string
  used: number
  size: number
  updatedAt: number
}

export interface Totals extends TokenBundle {
  /** 权威积分总额：直接来自 workbuddy.db 的计费记录，不受 transcript 是否还在影响 */
  credits: number
  /** 其中能对应到具体 transcript 的部分 */
  attributedCredits: number
  /** 只有积分记录、但 transcript 已不在本地的部分 —— 会话被清理过就会出现 */
  unattributedCredits: number
  sessions: number
  /** transcript 里出现过的计费回合数 */
  traces: number
  /** 其中能在积分记录里找到的 */
  matchedTraces: number
  /** 积分记录里的计费回合总数 */
  dbTraces: number
}

/**
 * 数据源。各边的账本口径都不同，界面必须知道自己在看哪一本：
 * WorkBuddy 有积分（token 只是副产品），Kimi Code / ZCode / MiMo / Reasonix /
 * DeepSeek Harness 只有 token，OpenCode Go 连 token 都没有 ——
 * 只有订阅额度的占用比例，而且还是联网查的。
 */
export type SourceKind = 'workbuddy' | 'kimi' | 'zcode' | 'mimo' | 'reasonix' | 'dsh' | 'opencode'

export interface SnapshotSource {
  /** 数据根目录 */
  dir: string
  /** 参与统计的数据文件数（transcript / wire.jsonl） */
  files: number
  /** 数据库行数；Kimi Code 没有库，恒为 0 */
  dbRows: number
}

export interface Snapshot {
  kind: SourceKind
  generatedAt: number
  totals: Totals
  today: TokenBundle & { credits: number }
  sessions: SessionStat[]
  days: DayStat[]
  models: ModelStat[]
  projects: ProjectStat[]
  active: ActiveContext | null
  source: SnapshotSource
  warnings: string[]
  /** 只有 OpenCode Go 会填：订阅额度水位，其它源没有这一层 */
  quota?: QuotaInfo
}

/* ------------------------------------------------ OpenCode Go 订阅额度 */

export type QuotaWindowKey = 'rolling' | 'weekly' | 'monthly'

/** 一个额度窗口的占用情况 */
export interface QuotaWindow {
  key: QuotaWindowKey
  /** 已用比例，0..100（服务端给整数） */
  percent: number
  /** 服务端状态串，目前只观测到 'ok' */
  status: string
  /** 窗口重置时刻（毫秒时间戳），0 表示服务端没给 */
  resetsAt: number
}

/** 一次额度采样（本地记的，用来画消耗趋势） */
export interface UsageSample {
  /** 采样时刻（毫秒时间戳） */
  t: number
  rolling: number
  weekly: number
  monthly: number
}

/**
 * OpenCode Go 的额度水位。
 * 这个源拿不到 token 明细 —— 接口只回三个百分比，整块界面靠它撑起来。
 */
export interface QuotaInfo {
  windows: QuotaWindow[]
  /** 最近一次成功拉取的时刻；从未成功过为 0 */
  fetchedAt: number
  /** 上次拉取失败，当前显示的是旧值 */
  stale: boolean
  /** 上次失败原因；成功时为 null */
  error: string | null
  /** 查询端点（展示用） */
  endpoint: string
  /** 凭证来源描述，绝不含密钥内容 */
  credential: string
  /** 最近的采样点，按时间升序 */
  history: UsageSample[]
}

/* ------------------------------------------------------------ 版本与更新 */

/**
 * 更新检查的状态。
 *
 * `unsupported` 不是错误 —— 开发模式与免安装版本来就装不了更新，
 * 界面要老老实实说明原因，而不是假装「已是最新」。
 */
export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** 当前运行的版本号 */
  current: string
  /** 远端发现的新版本号；未知时为空串 */
  latest: string
  /** 下载进度 0..100，仅 status === 'downloading' 时有意义 */
  percent: number
  /** 失败原因或「不支持」的原因；状态正常时为空串 */
  message: string
  /** 最近一次检查完成的时刻（毫秒）；从未查过为 0 */
  checkedAt: number
  /** 新版本的更新说明，可能为空 */
  notes: string
  /** 能否直接在本应用内下载 —— false 时只能去发布页手动下 */
  canDownload: boolean
}

/* ------------------------------------------------------------ 外观 */

/**
 * 界面外观。`system` 交给操作系统（Windows 的浅色 / 深色开关），
 * 另外两档是明确指定 —— 「系统是深色但这个工具偏要白底」时靠它们。
 */
export type ThemeMode = 'system' | 'light' | 'dark'

/* ------------------------------------------------------------ 桌面胶囊 */

export type FloatSize = 'small' | 'medium' | 'large'

export interface FloatPosition {
  x: number
  y: number
}

export interface Settings {
  /** 当前统计哪个数据源 */
  source: SourceKind
  /** 界面外观 */
  theme: ThemeMode
  /** 启动后自动检查更新（之后每 24 小时一次）；关掉就只能手动点「检查更新」 */
  autoCheckUpdate: boolean
  /** 发现新版本后自动下载；关掉只做提示，自己去发布页下 */
  autoDownloadUpdate: boolean
  /** 是否在桌面显示胶囊 */
  floatEnabled: boolean
  /** 胶囊整体不透明度，0.3 ~ 1 */
  floatOpacity: number
  /** 胶囊尺寸档位 */
  floatSize: FloatSize
  /** 是否始终置顶 */
  floatAlwaysOnTop: boolean
  /**
   * 是否给胶囊实心底色。
   * 透明窗口在部分 Windows 环境（显示缩放非 100% / 特定显卡驱动）会「存在但不可见」，
   * 所以留一个不透明的降级开关。
   */
  floatSolidBackground: boolean
  /** 上次拖到的位置；null 表示摆在默认的右下角 */
  floatPosition: FloatPosition | null
}

export interface FloatState {
  created: boolean
  visible: boolean
  loaded: boolean
  bounds: { x: number; y: number; width: number; height: number } | null
}
