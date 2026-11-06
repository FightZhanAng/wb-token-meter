import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'

/**
 * 冒烟自检的开关与落盘点。
 *
 * 结论写磁盘而不是 console.log —— Windows 上 GUI 进程不挂控制台，
 * 只靠 stdout 经常什么都看不到，"跑没跑起来"都判断不了。
 */
export const SMOKE = process.env['WB_TOKEN_METER_SMOKE'] === '1'
export const SMOKE_EXIT = process.env['WB_TOKEN_METER_SMOKE_EXIT'] === '1'

// 自检各步骤之间全是 await（截图、executeJavaScript）。渲染进程一旦无响应
// ——实测过的最常见诱因是 Chromium 的网络服务进程崩溃——这些 await 会永久挂起，
// 进程既不报错也不退出，调用方只能一直等。正常一轮约 40 秒，给到 2 分钟足够宽松。
export const SMOKE_TIMEOUT_MS = 120_000

/**
 * 切到 traecn 之后等多久量首屏。
 *
 * 要够晚 —— 晚到首帧真的画出来了（否则量到的是空白页，不是「画成了 0」）；
 * 也只要够晚 —— traecn 要扫二十几秒密钥，这段等待**不会**盖住它。800ms
 * 落在两者之间：首屏那一下 refresh() 是同步的，早于它画不出东西。
 */
export const SMOKE_FIRST_PAINT_MS = 800

/** 落盘目录（所有 json 与截图都在这儿）。每次调用都确保目录存在 */
export function smokeDir(): string {
  const dir = join(tmpdir(), 'wbtm-smoke')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function smoke(name: string, payload: unknown): void {
  if (!SMOKE) return
  try {
    writeFileSync(join(smokeDir(), `${name}.json`), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 自检失败不该影响主流程 */
  }
}

/**
 * 截图落盘。
 *
 * 失败**不抛**：某一张图存不下来，不该让后面十几步交互自检全部中断 ——
 * 那会把一个磁盘问题伪装成「界面坏了」。失败本身记一条，报告里看得见。
 */
export function shot(name: string, image: NativeImage): void {
  try {
    writeFileSync(join(smokeDir(), name), image.toPNG())
  } catch (error) {
    smoke('shot-error', { name, message: String(error) })
  }
}

/**
 * 等一等。
 *
 * 自检几乎每一步之后都要给渲染层一帧时间（设置落盘 → 广播 → React 重渲染 →
 * 样式生效），这些等待的时长各自有含义，所以统一叫 wait 而不是 sleep。
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
