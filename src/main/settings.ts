import { app } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { SOURCE_ORDER, THEME_ORDER } from '../shared/format'
import type { FloatPosition, Settings, SourceKind, ThemeMode } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  source: 'workbuddy',
  theme: 'system',
  floatEnabled: true,
  floatOpacity: 0.94,
  floatSize: 'medium',
  floatAlwaysOnTop: true,
  floatSolidBackground: false,
  floatPosition: null
}

const FILE_VERSION = 1
const FILE_NAME = 'wb-token-meter.json'

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function parsePosition(value: unknown): FloatPosition | null {
  if (!value || typeof value !== 'object') return null
  const point = value as Partial<FloatPosition>
  if (typeof point.x !== 'number' || typeof point.y !== 'number') return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

/** 数据源白名单跟着 SOURCE_ORDER 走 —— 加新源不用改这里，也不会再漏一个就静默回退 */
function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_ORDER as readonly string[]).includes(value)
}

/** 外观白名单同理，跟着 THEME_ORDER 走 */
function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_ORDER as readonly string[]).includes(value)
}

/** 逐字段校验：配置文件被手改坏时只回退那一个字段，不要整体重置 */
function parseSettings(raw: unknown): Settings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const size = input.floatSize
  const source = input.source
  const theme = input.theme
  return {
    source: isSourceKind(source) ? source : DEFAULT_SETTINGS.source,
    theme: isThemeMode(theme) ? theme : DEFAULT_SETTINGS.theme,
    floatEnabled:
      typeof input.floatEnabled === 'boolean' ? input.floatEnabled : DEFAULT_SETTINGS.floatEnabled,
    floatOpacity: clampNumber(input.floatOpacity, 0.3, 1, DEFAULT_SETTINGS.floatOpacity),
    floatSize: size === 'small' || size === 'medium' || size === 'large' ? size : DEFAULT_SETTINGS.floatSize,
    floatAlwaysOnTop:
      typeof input.floatAlwaysOnTop === 'boolean'
        ? input.floatAlwaysOnTop
        : DEFAULT_SETTINGS.floatAlwaysOnTop,
    floatSolidBackground:
      typeof input.floatSolidBackground === 'boolean'
        ? input.floatSolidBackground
        : DEFAULT_SETTINGS.floatSolidBackground,
    floatPosition: parsePosition(input.floatPosition)
  }
}

/**
 * 设置持久化。用「临时文件 + fsync + rename」做原子替换，
 * 避免断电 / 强杀进程时留下半个 JSON。
 */
export class SettingsStore {
  private readonly file: string
  private current: Settings

  constructor() {
    this.file = join(app.getPath('userData'), FILE_NAME)
    this.current = this.load()
  }

  get settings(): Settings {
    return this.current
  }

  get dataFile(): string {
    return this.file
  }

  patch(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch }
    this.flush()
    return this.current
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, unknown>
        return parseSettings(raw.settings)
      }
    } catch {
      // 配置文件坏了就回默认值 —— 不能因为一个设置文件起不来
    }
    return { ...DEFAULT_SETTINGS }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, settings: this.current }, null, 2), 'utf-8')
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
    } catch {
      // 写不进去也不能影响主流程
    }
  }
}
