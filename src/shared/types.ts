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
  /**
   * 本次调用的积分消耗。只有 Qoder CN 填这一项 ——
   * 它的服务端只回积分、不回 token，其余源不填（视作 0）。
   */
  credits?: number
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
  /**
   * 上下文水位比例 0..1。只有 Qoder CN 直接拿到比例（会话快照自带
   * context_usage_ratio），拿不到 token 绝对值时界面按它画水位。
   */
  contextRatio?: number
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
  credits: number
}

export interface ActiveContext {
  sessionId: string
  title: string
  cwd: string
  used: number
  size: number
  /** 水位比例 0..1；size 未知但拿到了比例时用它（Qoder CN 只有这一项） */
  ratio?: number
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
 * WorkBuddy 有积分（token 只是副产品），Qoder CN 有积分但**没有 token**
 * （服务端只回积分与上下文水位），Kimi Code / ZCode / MiMo / Reasonix /
 * DeepSeek Harness / OpenCode / TRAE SOLO CN 只有 token，OpenCode Go 连 token
 * 都没有 —— 只有订阅额度的占用比例，而且还是联网查的。
 * `opencode-desktop` 是 OpenCode 桌面端（opencode 引擎，与 CLI 共用本地库）
 * 的用量，与联网查额度的 `opencode`（OpenCode Go）是两本账。
 * `traecn` 是唯一**要先去别的进程内存里取密钥**的源（SQLCipher 加密库）。
 */
export type SourceKind =
  | 'workbuddy'
  | 'qoder'
  | 'kimi'
  | 'zcode'
  | 'mimo'
  | 'reasonix'
  | 'dsh'
  | 'traecn'
  | 'opencode-desktop'
  | 'opencode'

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

/**
 * 「关于 → 版本」弹窗要的东西：这个应用是什么版本、跑在什么环境上。
 * 全部由主进程回答 —— 渲染层拿不到 app.getVersion() / process.versions。
 */
export interface AppInfo {
  version: string
  /** 打包版还是开发模式。更新检查只在打包版里生效，这句必须显式告诉用户 */
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  /** 设置文件位置 —— 「我的配置存在哪」是最常被问的一句 */
  settingsFile: string
}

/* ------------------------------------------------------------ 外观 */

/**
 * 界面外观。`system` 交给操作系统（Windows 的浅色 / 深色开关），
 * 另外两档是明确指定 —— 「系统是深色但这个工具偏要白底」时靠它们。
 */
export type ThemeMode = 'system' | 'light' | 'dark'

/* ------------------------------------------------------------ 桌面胶囊 */

export type FloatSize = 'small' | 'medium' | 'large'

/**
 * 胶囊外观。**和面板的 ThemeMode 是两条独立的轴** ——
 * 面板只有跟随系统 / 浅色 / 深色，胶囊是贴在别人桌面上的一块牌子，
 * 多给几档风格、并且允许它不跟面板走（见 shared/capsule.ts 的说明）。
 */
export type CapsuleTheme = 'auto' | 'paper' | 'ink' | 'amber' | 'carbon'

/** 展开的卡片朝哪边 —— 由主进程按屏幕空间定，渲染层只管照摆 */
export type FloatCardSide = 'up' | 'down'

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
  /**
   * 胶囊自己的外观档位，**不跟随面板** ——
   * 面板深色而胶囊留白纸是很常见的偏好，两块东西本来就在不同的视觉环境里。
   */
  floatTheme: CapsuleTheme
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
  /** 卡片是否展开 —— 渲染层要靠它决定画胶囊还是胶囊 + 卡片 */
  expanded: boolean
  /**
   * 卡片朝上还是朝下。形状模式下收起态**沿用展开前的那一组** —— 渲染层要靠它
   * 把胶囊摆到 region 上；solid 降级模式收起时恒为 up。
   */
  side: FloatCardSide
  /**
   * 胶囊贴窗口的哪一侧（true = 贴右）。
   * 展开时窗口比胶囊宽，两边得贴同一边；横向贴哪边由主进程按屏幕位置定，
   * 渲染层只负责照摆 —— 计算只留一处，不然两边各算一次就会错位。
   */
  alignRight: boolean
  /**
   * 胶囊在屏幕上的位置。形状模式（透明窗口恒为展开尺寸）下窗口 bounds 不随
   * 收起/展开变化，核对「胶囊没漂」得看它，不能看 bounds。
   */
  capsule: { x: number; y: number } | null
  bounds: { x: number; y: number; width: number; height: number } | null
}
