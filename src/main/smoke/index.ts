import { app } from 'electron'
import { runCapsuleChecks } from './capsule'
import type { SmokeContext } from './context'
import { measureFirstPaint, runPanelChecks } from './panel'
import { runTopmostProbe } from './topmost'
import { SMOKE, SMOKE_EXIT, SMOKE_TIMEOUT_MS, smoke } from './writer'

export type { SmokeContext } from './context'

/**
 * 跑一轮界面自检，结论写到临时目录的 wbtm-smoke/ 下。
 *
 * 只在 WB_TOKEN_METER_SMOKE=1 时真的做事；其余情况立刻返回，调用点不用再包 if。
 *
 * 时序（搬迁前就长这样，别随手改）：
 * - 1200ms  量首屏。必须早于下面那轮完整采集，否则量到的是稳定态。
 * - 4000ms  跑完整一轮：截图、切源、主题、关于、更新、胶囊。
 * - 120s    看门狗。渲染进程无响应时那些 await 永不返回，只能靠它留证据并退出。
 */
export function runSmoke(ctx: SmokeContext): void {
  if (!SMOKE) return

  setTimeout(() => measureFirstPaint(ctx), 1200)

  // 看门狗：自检挂死时留下证据并主动退出，而不是让调用方干等
  const watchdog = setTimeout(() => {
    smoke('timeout', { limit: SMOKE_TIMEOUT_MS, at: Date.now() })
    if (SMOKE_EXIT) ctx.quit()
  }, SMOKE_TIMEOUT_MS)
  watchdog.unref?.()

  setTimeout(async () => {
    try {
      const win = ctx.mainWindow()
      if (win && !win.isDestroyed()) await runPanelChecks(ctx, win)
      await runCapsuleChecks(ctx)
      // 真实层级探针：会开盖板窗口抢焦点，比常规自检重得多，所以按需跑
      if (process.env['WB_TOKEN_METER_PROBE'] === '1') await runTopmostProbe(ctx)
    } catch (error) {
      smoke('capture-error', { message: String(error) })
    }

    smoke('ready', {
      at: Date.now(),
      appId: ctx.appId,
      packaged: app.isPackaged,
      windowVisible: ctx.mainWindow()?.isVisible() ?? false,
      windowDestroyed: ctx.mainWindow()?.isDestroyed() ?? true,
      trayCreated: ctx.tray() !== null,
      float: ctx.floatState(),
      settings: ctx.settings(),
      update: ctx.currentUpdate(),
      snapshot: (() => {
        const snapshot = ctx.snapshot()
        return snapshot
          ? {
              kind: snapshot.kind,
              source: snapshot.source,
              sessions: snapshot.totals.sessions,
              calls: snapshot.totals.calls,
              credits: snapshot.totals.credits,
              inputTokens: snapshot.totals.inputTokens,
              outputTokens: snapshot.totals.outputTokens,
              cachedTokens: snapshot.totals.cachedTokens,
              matchedTraces: snapshot.totals.matchedTraces,
              totalTraces: snapshot.totals.traces,
              active: snapshot.active,
              warnings: snapshot.warnings
            }
          : null
      })()
    })
    clearTimeout(watchdog)
    if (SMOKE_EXIT) ctx.quit()
  }, 4000)
}
