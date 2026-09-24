/** 共享类型定义 —— 主进程与渲染层都用这一份 */

/** 一次模型调用的用量记录 */
export interface CallRecord {
  traceId: string
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
 * 数据源。四边的账本口径都不同，界面必须知道自己在看哪一本：
 * WorkBuddy 有积分（token 只是副产品），Kimi Code / ZCode / MiMo 只有 token。
 */
export type SourceKind = 'workbuddy' | 'kimi' | 'zcode' | 'mimo'

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
}

/* ------------------------------------------------------------ 桌面胶囊 */

export type FloatSize = 'small' | 'medium' | 'large'

export interface FloatPosition {
  x: number
  y: number
}

export interface Settings {
  /** 当前统计哪个数据源 */
  source: SourceKind
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
