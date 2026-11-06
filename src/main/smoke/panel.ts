import type { BrowserWindow } from 'electron'
import { SOURCE_ORDER, sourceLabel } from '../../shared/format'
import type { SourceKind } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../settings'
import type { SmokeContext } from './context'
import { SMOKE_FIRST_PAINT_MS, shot, smoke, wait } from './writer'

/**
 * 首屏那一拍单独量：traecn 启动时要扫密钥，那十几秒里界面**不能**画成一个
 * 假装读完了的 0。这是这套交互的验收点，所以放在自检计时器起跑之前 ——
 * 后面那些度量跑的时候真值早就到了，量到的只会是稳定态。
 *
 * 前提是当前源就是 traecn，否则量到的会是别的源（毫秒级，本来就不该有骨架）。
 * 自检默认源是 workbuddy，所以先切过去再量。
 *
 * **切源就是改用户设置**：渲染层的 switchSource 走的是
 * `api.updateSettings({ source })`，不是某个只影响本次会话的旁路。所以这里
 * 必须自己还原 —— 下面切换循环末尾那个 `patchSettings({ source: sourceBefore })`
 * 救不了场：它的 sourceBefore 是**在 1200ms 之后**才捕获的，那时设置已经被
 * 这一段改成 traecn 了，还原等于没还原。用户下次启动会停在一个他从没选过的源上。
 */
export function measureFirstPaint(ctx: SmokeContext): void {
  const win = ctx.mainWindow()
  if (!win || win.isDestroyed()) return
  // 自己动手前先记住原样，还原时只认这一个值 —— 不用下游那个（它捕获得更晚）
  const sourceAtEntry = ctx.settings()?.source ?? 'workbuddy'
  const restore = (): void => {
    if (ctx.settings()?.source !== sourceAtEntry) {
      ctx.patchSettings({ source: sourceAtEntry })
    }
  }
  const measure = (): void => {
    void win.webContents
      .executeJavaScript(
        `(() => ({
           source: document.querySelector('.source-switch .active')?.textContent || '',
           blocks: document.querySelectorAll('.pending').length,
           title: document.querySelector('.pending-title')?.textContent || '',
           headline: [...document.querySelectorAll('.headline-value')].map((el) => el.textContent)
         }))()`
      )
      .then((paint) => {
        const first = paint as Record<string, unknown>
        smoke('first-paint', {
          ...first,
          // 核心一条：挂着骨架时绝不能同时画着数字 —— 那是「读完了读出 0」
          ok: (first['blocks'] as number) === 0 || ((first['headline'] as string[]) ?? []).length === 0,
          // 这一段动过用户设置，报告里必须能自证还原回去了
          restoredFrom: sourceAtEntry
        })
        return win.webContents.capturePage()
      })
      .then((image) => shot('window-first-paint.png', image))
      .catch(() => undefined)
      // 还原放在最后，且**不挂在 measure 的链上**：截图或度量失败时也要还原，
      // 否则一次自检失败就把用户设置留在 traecn 上
      .finally(() => restore())
  }
  if (sourceAtEntry === 'traecn') {
    measure()
  } else {
    void win.webContents
      .executeJavaScript(
        `(() => {
           const root = document.querySelector('.source-switch')
           const label = ${JSON.stringify(sourceLabel('traecn'))}
           const direct = [...root.querySelectorAll('button')].find((el) => el.textContent.trim() === label)
           if (direct) direct.click()
           else root.querySelector('.source-more')?.click()
         })()`
      )
      .then(() => wait(400))
      .then(() =>
        win.webContents.executeJavaScript(
          `(() => {
             const label = ${JSON.stringify(sourceLabel('traecn'))}
             const item = [...document.querySelectorAll('.source-menu button')].find((el) => el.textContent.trim() === label)
             if (item) item.click()
           })()`
        )
      )
      .then(() => wait(SMOKE_FIRST_PAINT_MS))
      .then(measure)
      .catch(() => undefined)
      // 中途失败（按钮没找到、窗口没了）同样要还原 —— 这条链上的 catch
      // 不会走进 measure 的 finally
      .finally(() => restore())
  }
}

/**
 * 主窗口那一整轮：截图、DOM 度量、切源、窄宽、主题、关于、更新底栏。
 *
 * 没有内层 try —— 任何一步抛错都由调用方统一记成 capture-error，
 * 与搬迁前那个大 try 的行为一致。
 */
export async function runPanelChecks(ctx: SmokeContext, win: BrowserWindow): Promise<void> {
  // 无头环境里，截图 + DOM 度量是唯一能确认「界面真的画出来了」的手段 ——
  // 窗口 isVisible() 为 true 也可能是空白（工具环境常见，见项目 skill 坑 8）
  shot('window.png', await win.webContents.capturePage())
  const metrics = await win.webContents.executeJavaScript(
    `(() => {
       const heat = document.querySelector('.heatmap')
       const active = document.querySelector('.source-switch .active')
       return {
         sections: document.querySelectorAll('.ch').length,
         theme: document.documentElement.dataset.theme || '',
         bodyHeight: document.body.scrollHeight,
         title: document.querySelector('.app-title')?.textContent || '',
         source: active ? active.textContent : '',
         sessionRows: document.querySelectorAll('.session-row').length,
         creditRows: document.querySelectorAll('.session-credits').length,
         headline: [...document.querySelectorAll('.headline-value')].map((el) => el.textContent),
         heatCells: heat ? heat.children.length : 0,
         heatWidth: heat ? heat.clientWidth : 0,
         heatScrollWidth: heat ? heat.scrollWidth : 0
       }
     })()`
  )
  smoke('dom', metrics)

  // 再滚到热力图截一张，确认它没有被裁掉
  await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.heatmap'); if (el) el.scrollIntoView({ block: 'center' }); })()`
  )
  await wait(400)
  shot('window-heat.png', await win.webContents.capturePage())

  // 数据源切换的端到端自检：逐个点过去 -> IPC -> 重采 -> 重绘，最后切回原样。
  // 只在自检里跑，跑完立刻切回去，免得把用户自己的设置改掉。
  const sourceBefore = ctx.settings()?.source ?? 'workbuddy'
  const switches: Array<{ expected: SourceKind; actual: SourceKind | undefined; dom: unknown }> = []
  /** 切源 1.5 秒后还挂着载入态的源 —— traecn 属预期（扫密钥要二十几秒），其余才是漏 */
  const stablePendingLeaks: SourceKind[] = []
  const pendingHeld: Array<{ source: SourceKind; title: string }> = []
  for (const target of SOURCE_ORDER) {
    if (target === sourceBefore) continue
    // 前三个源就是按钮本身，其余收在「更多」下拉里 —— 两条路径都要真的点一遍
    const label = JSON.stringify(sourceLabel(target))
    await win.webContents.executeJavaScript(
      `(() => {
         const root = document.querySelector('.source-switch')
         if (!root) return
         const direct = [...root.querySelectorAll('button')].find((el) => el.textContent.trim() === ${label})
         if (direct) direct.click()
         else root.querySelector('.source-more')?.click()
       })()`
    )
    await wait(250)
    await win.webContents.executeJavaScript(
      `(() => {
         const item = [...document.querySelectorAll('.source-menu button')].find((el) => el.textContent.trim() === ${label})
         if (item) item.click()
       })()`
    )
    await wait(1500)
    const switched = await win.webContents.executeJavaScript(
      `(() => {
         const active = document.querySelector('.source-switch .active')
         return {
           active: active ? active.textContent : '',
           subtitle: document.querySelector('.app-subtitle')?.textContent || '',
           headline: [...document.querySelectorAll('.headline-value')].map((el) => el.textContent),
           sessionRows: document.querySelectorAll('.session-row').length,
           creditRows: document.querySelectorAll('.session-credits').length,
           contextNote: document.querySelector('.gauge-foot')?.textContent || '',
           modelHints: [...document.querySelectorAll('.bar-value em')].map((el) => el.textContent)
         }
       })()`
    )
    // 载入态要在切源后立刻量：切到 traecn 时它要去扫密钥，那十几秒里
    // 界面上不能是一个假装读完了的 0（真值到了之后 .pending 必然为 0，
    // 所以这里量的就是「稳定态不该有骨架」这一半）。
    const pendingAfter = await win.webContents.executeJavaScript(
      `(() => ({
         blocks: document.querySelectorAll('.pending').length,
         title: document.querySelector('.pending-title')?.textContent || ''
       }))()`
    )
    const pendingTitle = pendingAfter.title
    // 骨架那一拍单独留张图：它是这套交互唯一「平时看不到」的形态
    if (pendingAfter.blocks > 0) {
      shot(`window-pending-${target}.png`, await win.webContents.capturePage())
    }
    // 截图前先滚回顶部：自检要能一眼看到「今日」与上下文水位这两张卡
    await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.app-body'); if (el) el.scrollTop = 0 })()`
    )
    await wait(300)
    shot(`window-${target}.png`, await win.webContents.capturePage())
    switches.push({ expected: target, actual: ctx.settings()?.source, dom: switched })
    // 切完一轮之后还挂着骨架 —— 分两种情况，判定相反：
    // - traecn：1.5 秒远不够（扫密钥 ~21 秒），这时挂着骨架**是对的**
    // - 其余源：都是毫秒级，真值早该到了，这时还挂着就是漏了
    // pendingAfter 是 { blocks, title } 对象，比较必须取 .blocks ——
    // 直接拿对象跟 0 比会走对象转数字得到 NaN，NaN > 0 恒假，
    // 于是这一整段永远不进分支，pending.ok 永远为真、什么缺陷都测不出来。
    if (pendingAfter.blocks > 0) {
      pendingHeld.push({ source: target, title: pendingTitle || '(无标题)' })
      if (target !== 'traecn') stablePendingLeaks.push(target)
    }
  }
  smoke('source-switch', { from: sourceBefore, switches })
  smoke('pending', {
    // 切源后仍挂着骨架的源；traecn 属预期，其余为空才对
    held: pendingHeld,
    leaks: stablePendingLeaks,
    // 关键一条：骨架在的时候绝不能同时画着数字（那是「读完了读出 0」）
    noFakeZero: pendingHeld.every((entry) => {
      const dom = switches.find((s) => s.expected === entry.source)?.dom as
        | { headline?: string[] }
        | undefined
      return (dom?.headline ?? []).length === 0
    }),
    ok: stablePendingLeaks.length === 0
  })
  ctx.patchSettings({ source: sourceBefore })
  await wait(1500)

  // 切回来之后，DOM 里的会话行数必须等于当前快照的会话数。
  // 多出来就是残留：会话快照里同一个 sessionId 会出现两次，
  // 列表 key 撞车时 React 对账会漏删，上一批行留在 DOM 里。
  const afterSwitchBack = await win.webContents.executeJavaScript(
    `(() => {
       const c = document.querySelector('.sessions')
       return {
         source: document.querySelector('.source-switch .active')?.textContent || '',
         rows: document.querySelectorAll('.session-row').length,
         creditRows: document.querySelectorAll('.session-credits').length,
         containerChildren: c ? c.children.length : -1
       }
     })()`
  )
  smoke('after-switch-back', {
    expected: sourceBefore,
    actual: ctx.settings()?.source,
    expectedRows: Math.min((ctx.snapshot()?.sessions ?? []).length, 40),
    dom: afterSwitchBack
  })

  // 顶栏在最小宽度下不能被撑破：四个数据源按钮 + 刷新挤在一行，
  // scrollWidth 超过 clientWidth 就是溢出了（窗口默认 560，最小 460）
  const originalBounds = win.getBounds()
  win.setSize(460, originalBounds.height)
  await wait(400)
  const narrow = await win.webContents.executeJavaScript(
    `(() => {
       const header = document.querySelector('.app-header')
       const actions = document.querySelector('.header-actions')
       const caption = document.querySelector('.app-caption')
       const guard = document.querySelector('.app-caption-guard')
       const rect = (el) => (el ? el.getBoundingClientRect() : null)
       const actionsRect = rect(actions)
       const guardRect = rect(guard)
       const captionRect = rect(caption)
       return {
         viewportWidth: window.innerWidth,
         headerClientWidth: header ? header.clientWidth : -1,
         headerScrollWidth: header ? header.scrollWidth : -1,
         actionsWidth: actionsRect ? Math.round(actionsRect.width) : -1,
         subtitle: document.querySelector('.app-subtitle')?.textContent || '',
         // 自绘标题栏：标题栏那条只放窗口 chrome，guardWidth 是留给系统三键的
         // 宽度，0 就是环境变量没拿到（三键会压到应用内容上）；
         // actionsBelowCaption 必须为 true —— 应用的按钮不能跑进标题栏那条
         captionHeight: captionRect ? Math.round(captionRect.height) : -1,
         guardWidth: guardRect ? Math.round(guardRect.width) : -1,
         actionsBelowCaption:
           actionsRect && captionRect ? Math.round(actionsRect.top) >= Math.round(captionRect.bottom) : true
       }
     })()`
  )
  smoke('narrow-header', narrow)
  win.setSize(originalBounds.width, originalBounds.height)
  await wait(300)

  // 两套外观各截一张：深色主题只有真看一眼才知道对不对，
  // 顺手把 dataset.theme 与实测底色回报出来，免得「设置改了但 CSS 没跟上」。
  const themeBefore = ctx.settings()?.theme ?? 'system'
  const themeShots: Array<{ mode: string; actual: string | undefined; dom: unknown }> = []
  for (const mode of ['dark', 'light'] as const) {
    ctx.patchSettings({ theme: mode })
    await wait(700)
    const dom = await win.webContents.executeJavaScript(
      `(() => {
         const body = getComputedStyle(document.body)
         // 这套设计押在 Bahnschrift（DIN 血统，Win10+ 自带）上，
         // 量一下字宽才知道它到底在不在 —— getComputedStyle 只会把 CSS 原样念回来
         const probe = (font) => {
           const canvasCtx = document.createElement('canvas').getContext('2d')
           canvasCtx.font = '40px ' + font
           return Math.round(canvasCtx.measureText('Token 0123456789').width)
         }
         const counter = document.querySelector('.headline-value')
         return {
           stamped: document.documentElement.dataset.theme || '',
           prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
           background: body.backgroundColor,
           color: body.color,
           sections: document.querySelectorAll('.ch').length,
           themeButton: document.querySelector('.theme-toggle')?.textContent || '',
           counterFont: counter ? getComputedStyle(counter).fontFamily.split(',')[0] : '',
           fontWidth: {
             bahnschrift: probe('Bahnschrift'),
             segoe: probe('"Segoe UI"'),
             sans: probe('sans-serif')
           }
         }
       })()`
    )
    shot(`window-${mode}.png`, await win.webContents.capturePage())
    themeShots.push({ mode, actual: ctx.settings()?.theme, dom })
  }
  smoke('theme', { before: themeBefore, shots: themeShots })
  ctx.patchSettings({ theme: themeBefore })
  await wait(400)

  /* 标题栏左角的「关于」：菜单三项 -> 版本弹窗 -> 关闭。
     版本号与运行环境是主进程答的，所以这里连 IPC 一起验了。 */
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.about-entry')?.click() })()`)
  await wait(250)
  const aboutMenu = await win.webContents.executeJavaScript(
    `(() => {
       const menu = document.querySelector('.about-menu')
       return {
         open: !!menu,
         items: [...(menu ? menu.querySelectorAll('button') : [])].map((el) => el.textContent.trim())
       }
     })()`
  )
  shot('window-about-menu.png', await win.webContents.capturePage())

  await win.webContents.executeJavaScript(
    `(() => {
       const btn = [...document.querySelectorAll('.about-menu button')]
         .find((el) => el.textContent.trim().startsWith('版本'))
       if (btn) btn.click()
     })()`
  )
  await wait(300)
  const aboutDialog = await win.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.about-card')
       return {
         open: !!card,
         version: document.querySelector('.about-number')?.textContent || '',
         rows: [...(card ? card.querySelectorAll('.about-row') : [])].map((el) => el.textContent.trim()),
         actions: [...(card ? card.querySelectorAll('.about-actions button') : [])].map((el) =>
           el.textContent.trim()
         )
       }
     })()`
  )
  shot('window-about-version.png', await win.webContents.capturePage())

  await win.webContents.executeJavaScript(
    `(() => {
       const btn = [...document.querySelectorAll('.about-actions button')]
         .find((el) => el.textContent.trim() === '关闭')
       if (btn) btn.click()
     })()`
  )
  await wait(200)
  const aboutClosed = await win.webContents.executeJavaScript(
    `(() => !document.querySelector('.about-card') && !document.querySelector('.about-menu'))()`
  )
  smoke('about', { menu: aboutMenu, dialog: aboutDialog, closed: aboutClosed })

  /* 底栏的版本与更新：点「检查更新」-> 发现新版本 -> 点「下载更新」-> 已就绪。
     假版本号由模块顶层的 WB_TOKEN_METER_FAKE_UPDATE 注入，全程不走网络。 */
  const settingsBeforeUpdate = { ...(ctx.settings() ?? DEFAULT_SETTINGS) }

  const readFooter = async (): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `(() => {
         const footer = document.querySelector('.app-footer')
         const box = footer ? footer.getBoundingClientRect() : null
         return {
           version: document.querySelector('.foot-version')?.textContent || '',
           state: document.querySelector('.foot-state')?.textContent || '',
           status: document.querySelector('.foot-state')?.dataset.status || '',
           actions: [...document.querySelectorAll('.foot-actions button')].map((el) => el.textContent.trim()),
           switches: [...document.querySelectorAll('.foot-row.switches .switch')].map((el) => ({
             label: el.textContent.trim(),
             checked: el.querySelector('input') ? el.querySelector('input').checked : null,
             disabled: el.querySelector('input') ? el.querySelector('input').disabled : null
           })),
           // 底栏是固定的一条，必须落在视口内且贴着下沿
           footer: box
             ? { top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: window.innerHeight }
             : null
         }
       })()`
    )

  const clickFooterButton = async (label: string): Promise<void> => {
    await win.webContents.executeJavaScript(
      `(() => {
         const btn = [...document.querySelectorAll('.foot-actions button')]
           .find((el) => el.textContent.trim() === ${JSON.stringify(label)})
         if (btn) btn.click()
       })()`
    )
  }

  const footerIdle = await readFooter()
  await clickFooterButton('检查更新')
  await wait(700)
  const footerAvailable = await readFooter()
  await clickFooterButton('下载更新')
  await wait(700)
  const footerDownloaded = await readFooter()
  shot('window-update.png', await win.webContents.capturePage())

  // 开关要真的落到设置文件里，而不是只在界面上动一下
  const autoCheckWas = ctx.settings()?.autoCheckUpdate ?? true
  await win.webContents.executeJavaScript(
    `(() => {
       const box = document.querySelector('.foot-row.switches .switch input')
       if (box) box.click()
     })()`
  )
  await wait(400)
  const footerAfterToggle = await readFooter()

  smoke('update', {
    idle: footerIdle,
    available: footerAvailable,
    downloaded: footerDownloaded,
    afterToggle: footerAfterToggle,
    autoCheck: { was: autoCheckWas, now: ctx.settings()?.autoCheckUpdate },
    state: ctx.currentUpdate()
  })

  // 自检动过的设置全部还原，别留给用户
  ctx.patchSettings({
    autoCheckUpdate: settingsBeforeUpdate.autoCheckUpdate,
    autoDownloadUpdate: settingsBeforeUpdate.autoDownloadUpdate
  })
  await wait(300)
}
