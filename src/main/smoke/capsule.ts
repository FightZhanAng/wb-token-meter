import { CAPSULE_THEME_ORDER } from '../../shared/capsule'
import type { CapsuleTheme } from '../../shared/types'
import type { MenuChoice } from '../tray'
import type { SmokeContext } from './context'
import { shot, smoke, wait } from './writer'

/**
 * 桌面胶囊那一整轮：截图、四角透明、展开卡片、收起、置顶开关、各档主题。
 *
 * 没有内层 try —— 任何一步抛错都由调用方统一记成 capture-error。
 */
export async function runCapsuleChecks(ctx: SmokeContext): Promise<void> {
  // 桌面胶囊单独截一张，并回报 DOM 度量
  const floatWin = ctx.floatWindow()?.browserWindow
  if (!floatWin || floatWin.isDestroyed()) return

  /*
   * 截图前把所有动效关掉。
   *
   * 卡片是「200ms 弹入 + 六段 40ms 错峰」，配合 animation-fill-mode: both，
   * 动画没走到时元素停在 0% 那一帧（opacity 0）。而窗口一旦被别的窗口盖住，
   * 合成器会节流、动画就停在那儿不动 —— 抓出来的图只有胶囊、上面一片空白，
   * 看着像「卡片没渲染」，实际是帧没往后走。这也是为什么同一份代码
   * 有时拍得到卡片、有时拍不到。
   */
  await floatWin.webContents.insertCSS(
    '*, *::before, *::after { animation: none !important; transition: none !important; }'
  )

  const image = await floatWin.webContents.capturePage()
  shot('float.png', image)

  // 直接用位图验四角透明 —— 只把 PNG 存下来肉眼分不出「透明」和「白」。
  // 用 toBitmap()：getBitmap() 在 Electron 43 上已经是 deprecated 别名，
  // 每跑一轮自检都会往 stderr 吐一条警告。
  const pixels = image.toBitmap()
  const size = image.getSize()
  const alphaAt = (x: number, y: number): number => pixels[(y * size.width + x) * 4 + 3]
  smoke('float-pixels', {
    size,
    corners: {
      左上: alphaAt(0, 0),
      右上: alphaAt(size.width - 1, 0),
      左下: alphaAt(0, size.height - 1),
      右下: alphaAt(size.width - 1, size.height - 1)
    },
    中心: alphaAt(Math.floor(size.width / 2), Math.floor(size.height / 2)),
    底边: alphaAt(Math.floor(size.width / 2), size.height - 2)
  })

  const metrics = await floatWin.webContents.executeJavaScript(
    `(() => {
       const el = document.querySelector('.capsule')
       return {
         capsule: !!el,
         tokens: document.querySelector('.tokens')?.textContent || '',
         credits: document.querySelector('.credits')?.textContent || '',
         capsuleSize: el ? [el.clientWidth, el.clientHeight] : null,
         viewport: [window.innerWidth, window.innerHeight],
         theme: document.documentElement.dataset.capsule || ''
       }
     })()`
  )
  smoke('float-dom', metrics)

  /*
   * 展开卡片的端到端自检。
   *
   * 必须派发真的 pointerdown / pointerup 而不是 el.click()：
   * 单击是渲染层自己用一对指针事件判出来的（拖动与单击共用一套），
   * 合成的 click 事件根本走不到那段逻辑 —— 那样测出来的只是「能改状态」，
   * 测不到「点一下胶囊真的会展开」。
   */
  const clickCapsule = `(() => {
     const el = document.querySelector('.capsule')
     if (!el) return false
     const box = el.getBoundingClientRect()
     const at = {
       bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
       clientX: box.left + 8, clientY: box.top + box.height / 2,
       screenX: 200, screenY: 200
     }
     el.dispatchEvent(new PointerEvent('pointerdown', at))
     el.dispatchEvent(new PointerEvent('pointerup', at))
     return true
   })()`

  const collapsedBounds = floatWin.getBounds()
  const collapsedCapsule = ctx.floatState().capsule
  await floatWin.webContents.executeJavaScript(clickCapsule)
  await wait(700)

  shot('float-card.png', await floatWin.webContents.capturePage())
  const cardDom = await floatWin.webContents.executeJavaScript(
    `(() => {
       const card = document.querySelector('.card')
       const el = document.querySelector('.capsule')
       return {
         card: !!card,
         side: card ? card.dataset.side : '',
         align: card ? card.dataset.align : '',
         cardSize: card ? [card.clientWidth, card.clientHeight] : null,
         source: document.querySelector('.card-src')?.textContent || '',
         hero: document.querySelector('.hero-value')?.textContent || '',
         cells: [...document.querySelectorAll('.cell')].map((el) => el.textContent),
         gauge: document.querySelector('.gauge-num')?.textContent || '',
         bars: document.querySelectorAll('.spark i').length,
         barHeights: [...document.querySelectorAll('.spark i')].map((el) => el.style.height || '0'),
         cardScroll: card ? [card.clientHeight, card.scrollHeight] : null,
         /*
          * 卡片**画出来了没有**。DOM 里有、尺寸也对，但 opacity 停在 0 的动画帧
          * 上时截出来就是一片空白 —— 只看截图分不清是没渲染还是没画上去。
          */
         reveal: card
           ? (() => {
               const style = getComputedStyle(card)
               const box = card.getBoundingClientRect()
               return {
                 opacity: style.opacity,
                 visibility: style.visibility,
                 display: style.display,
                 animation: style.animationName,
                 background: style.backgroundColor,
                 rect: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]
               }
             })()
           : null,
         /*
          * 分项高度 —— FLOAT_CARD.height 是写死的，改它之前得知道这 234px
          * 到底被谁吃掉了。cardScroll 只能告诉你「溢出多少」，告诉不了
          * 「哪一段变胖了」；字体度量一变就在这儿看得出来。
          */
         sections: card
           ? [...card.children].map((node) => [
               node.className,
               Math.round(node.getBoundingClientRect().height)
             ])
           : null,
         actions: [...document.querySelectorAll('.card-foot button')].map((el) => el.textContent),
         pin: (() => {
           const el = document.querySelector('.card-icon.pin')
           return el
             ? {
                 present: true,
                 on: el.dataset.on,
                 pressed: el.getAttribute('aria-pressed'),
                 title: el.getAttribute('title')
               }
             : { present: false }
         })(),
         capsuleSize: el ? [el.clientWidth, el.clientHeight] : null,
         viewport: [window.innerWidth, window.innerHeight]
       }
     })()`
  )
  smoke('float-card', {
    expanded: ctx.floatState().expanded,
    side: ctx.floatState().side,
    before: collapsedBounds,
    after: floatWin.getBounds(),
    dom: cardDom
  })

  // 收起：卡片再点一次胶囊就该回去，且胶囊的位置不能漂
  await floatWin.webContents.executeJavaScript(clickCapsule)
  await wait(500)
  smoke('float-collapse', {
    expanded: ctx.floatState().expanded,
    bounds: floatWin.getBounds(),
    capsuleBefore: collapsedCapsule,
    capsuleAfter: ctx.floatState().capsule
  })

  /*
   * 卡片上的置顶开关：要验的是**窗口真的换了层级**，而不是按钮的 class 变了。
   *
   * 只看 DOM 的话，「点了有反应」和「窗口置顶了」是两回事 —— 前者任何
   * 一点样式变化都能满足。所以这里读 BrowserWindow.isAlwaysOnTop()：
   * 那是 DWM 视角的事实。顺手也确认设置落盘了（重启后要还是这个值）。
   *
   * 测完必须复原：把置顶关掉，否则后面那些截图步骤会在最前一层跑，
   * 报告里的层级前提就不对了。
   */
  const alwaysOnTopStep = async (): Promise<{
    before: boolean
    after: boolean
    stored: boolean
    pressed: string | null
  }> => {
    const before = floatWin.isAlwaysOnTop()
    await floatWin.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.card-icon.pin'); if (el) el.click(); return !!el })()`
    )
    await wait(400)
    const after = floatWin.isAlwaysOnTop()
    const pressed = await floatWin.webContents.executeJavaScript(
      `document.querySelector('.card-icon.pin')?.getAttribute('aria-pressed') ?? null`
    )
    return { before, after, stored: ctx.settings()?.floatAlwaysOnTop ?? before, pressed }
  }

  // 先展开卡片（置顶按钮在卡片头上）
  await floatWin.webContents.executeJavaScript(clickCapsule)
  await wait(700)
  const onTopOff = await alwaysOnTopStep()
  // 再点回来，确认它是个开关而不是单向置位
  const onTopOn = await alwaysOnTopStep()
  smoke('float-always-on-top', {
    off: onTopOff,
    back: onTopOn,
    restored: floatWin.isAlwaysOnTop(),
    stored: ctx.settings()?.floatAlwaysOnTop ?? null
  })
  // 复原成默认的置顶（true），让后续步骤的层级前提与基线一致
  if (!floatWin.isAlwaysOnTop()) {
    await alwaysOnTopStep()
    await wait(300)
  }

  /*
   * 每个胶囊主题各截两张：收起态的胶囊、展开态的卡片。
   * 主题是**独立于面板**的一条轴，所以这里不看 prefers-color-scheme，
   * 只看 data-capsule 有没有被解析成对应那一档。
   *
   * 卡片也必须一起看：它和胶囊用的是同一份令牌，但「胶囊颜色对了」
   * 推不出「卡片也对了」—— 卡片上一堆底色、分隔线、刻度槽的搭配只有
   * 亲眼看截图才判得出来，而它恰恰是展开后用户盯着的那一块。
   * 顺手把每档的 cardScroll 记下来：溢出对主题无关，但换主题会换掉
   * 字体外的所有东西，多一列冗余的证词不亏。
   */
  const themeBefore = ctx.settings()?.floatTheme ?? 'auto'
  const themes: Array<{
    theme: CapsuleTheme
    resolved: string
    cardScroll: number[] | null
    menu: MenuChoice[]
    menuAgree: boolean
  }> = []
  for (const theme of CAPSULE_THEME_ORDER) {
    ctx.patchSettings({ floatTheme: theme })
    /*
     * 立刻把菜单读出来，**不给下一次快照留重建的机会** —— 这一条要测的正是
     * 「设置一变就重建」。菜单里那几项标题带着当前档位（「胶囊主题：深靛」），
     * 子菜单里还有一个被勾中的项，两个说法必须一致。
     * 不一致的表现是：圆点被系统挪到了新档位、标题还停在旧档位。
     */
    const menu = ctx.tray()?.describeChoices() ?? []
    const menuAgree = menu
      .filter((entry) => entry.label.includes('：'))
      .every((entry) => entry.label.split('：')[1] === entry.checked)
    await wait(400)
    const resolved = await floatWin.webContents.executeJavaScript(
      `document.documentElement.dataset.capsule || ''`
    )
    shot(`float-${theme}.png`, await floatWin.webContents.capturePage())

    // 点一下展开、再点一下收起 —— 同一个 clickCapsule 脚本就能来回切
    await floatWin.webContents.executeJavaScript(clickCapsule)
    await wait(600)
    shot(`float-card-${theme}.png`, await floatWin.webContents.capturePage())
    const cardScroll = await floatWin.webContents.executeJavaScript(
      `(() => { const c = document.querySelector('.card'); return c ? [c.clientHeight, c.scrollHeight] : null })()`
    )
    await floatWin.webContents.executeJavaScript(clickCapsule)
    await wait(400)
    themes.push({ theme, resolved, cardScroll, menu, menuAgree })
  }
  smoke('float-theme', { before: themeBefore, themes })
  ctx.patchSettings({ floatTheme: themeBefore })
  await wait(300)
}
