import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { CAPSULE_SIZES } from '../../shared/layout'
import type { FloatState } from '../../shared/types'
import type { SmokeContext } from './context'
import { shot, smoke, wait } from './writer'

/**
 * 胶囊「始终置顶」的真实层级探针（WB_TOKEN_METER_PROBE=1 时才跑）。
 *
 * 为什么要单独做一套：`BrowserWindow.isAlwaysOnTop()` 只是 Electron 自己记的
 * 那个布尔值，不代表窗口真的压在别人上面 —— capsule.ts 里那条开关自检因此
 * 只能证明「点了有反应」，证不了「真的在最上层」。
 *
 * 做法：开一个**普通窗口**盖住胶囊，把它抬到普通窗口层的最上面，然后截屏，
 * 数「胶囊那块矩形里有多少像素是盖板色」：几乎全是 → 被盖住了；几乎没有 →
 * 胶囊压在上面。盖板比胶囊大一圈，多出来那块空地用来自检 —— 那里都不是纯色，
 * 说明这张图不干净（盖板没出来 / 被别的应用挡着），结论直接作废。
 *
 * 三个坑，改之前先看：
 * 1) 盖板只是 `show()` 会被前台别的应用压住，参照区就变成了别人的界面；
 *    光 `moveTop()` 也不行。先置顶再取消置顶，它才稳稳落在普通窗口层最上面。
 * 2) Windows 会给刚移动/改尺寸的窗口留一层合成残留（同一块地方出现「旧影子」），
 *    所以第一次截图丢掉不用，隔一会儿再截第二张。
 * 3) 探针会抢焦点，卡片会被 blur 收起（产品行为）。所以采样前先把卡片收好，
 *    点按钮时按「期望状态」而不是盲点一下。
 */

/** 盖板色：品红。判据是「这块区域里有多少像素是它」，不跟别的颜色比 */
const COVER_COLOR = '#ff00ff'
/** 盖板比胶囊每边大出多少，给「纯色参照区」留地方 */
const PAD = 120
/** 胶囊矩形里盖板色占比超过它，判定为「没压住」 */
const COVERED_MIN_RATIO = 0.35
/** 盖板空地里盖板色占比低于它，说明这张图不干净，结论不可信 */
const SANE_MIN_RATIO = 0.8

type Rgb = [number, number, number]

interface Sample {
  label: string
  /** 胶囊矩形内「盖板色」所占的比例：接近 0 说明胶囊挡在上面，接近 1 说明被盖住了 */
  capsuleCover: number | null
  /** 盖板空地里的同一比例。它不接近 1，说明截出来根本不是一个纯色盖板 */
  padCover: number | null
  /** 胶囊中心那一个像素，留作肉眼参照 */
  center: Rgb | null
  /** 结论：胶囊是不是真的压在盖板上面 */
  onTop: boolean | null
  /** Electron 自报的值，专门用来看它和事实有没有分歧 */
  reported: boolean
  /** 采样那一刻设置里的值 —— 与 reported 对比才知道是「没落盘」还是「落盘没应用」 */
  setting: boolean | null
  /** 卡片当时是不是展开的（展开态下胶囊上方是卡片） */
  expanded: boolean
  /** 卡片上那个图钉按钮的 aria-pressed，空字符串表示按钮不在 DOM 里 */
  pin: string | null
  /** 采样时 FloatWindow 自己的状态快照 —— 窗口被重建后 this.win 有没有变成别的对象，看这里 */
  float?: FloatState
  /** 采样的胶囊矩形（DIP） */
  at: [number, number, number, number] | null
  /** 截图链路本身的信息 —— 采错了点要先看这里，别急着怀疑产品代码 */
  capture?: {
    width: number
    height: number
    scale: [number, number]
    displays: number
    matched: boolean
  }
  note?: string
}

function isCoverColor(pixel: Rgb): boolean {
  // 品红在 R/B 上对称，通道序对调也成立
  return (
    Math.abs(pixel[0] - 255) <= 12 && pixel[1] <= 16 && Math.abs(pixel[2] - 255) <= 12
  )
}

/** 一块矩形里「盖板色」的占比 */
function coverRatio(
  cap: {
    bitmap: Buffer
    width: number
    height: number
    scale: [number, number]
    origin: [number, number]
  },
  rect: { x: number; y: number; width: number; height: number }
): number | null {
  const x0 = Math.round((rect.x - cap.origin[0]) * cap.scale[0])
  const y0 = Math.round((rect.y - cap.origin[1]) * cap.scale[1])
  const x1 = Math.round((rect.x + rect.width - cap.origin[0]) * cap.scale[0])
  const y1 = Math.round((rect.y + rect.height - cap.origin[1]) * cap.scale[1])
  const left = Math.max(0, x0)
  const top = Math.max(0, y0)
  const right = Math.min(cap.width, x1)
  const bottom = Math.min(cap.height, y1)
  if (right - left < 4 || bottom - top < 4) return null

  let hit = 0
  let total = 0
  // 每 2 个像素采一次：一整块屏逐像素扫太慢，2px 间距已经足够代表这块区域
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      total++
      if (isCoverColor(readPixel(cap.bitmap, cap.width, x, y))) hit++
    }
  }
  return total === 0 ? null : Number((hit / total).toFixed(3))
}

/** toBitmap() 给的是原始字节，通道序跟平台有关（Windows 上是 BGRA）。
 *  判据只比较「两个采样点差多少」，通道序对调不影响结论，所以不做反推。 */
function readPixel(bitmap: Buffer, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4
  return [bitmap[offset] ?? 0, bitmap[offset + 1] ?? 0, bitmap[offset + 2] ?? 0]
}

interface Capture {
  bitmap: Buffer
  width: number
  height: number
  /** 物理像素 / DIP */
  scale: [number, number]
  /** 这块屏在屏幕坐标系里的原点（DIP） */
  origin: [number, number]
  displays: number
  /** 是否按 display_id 命中了那块屏；没命中时采的是 sources[0]，可能不是同一块 */
  matched: boolean
  image: Electron.NativeImage
}

async function capture(display: Electron.Display): Promise<Capture | null> {
  const factor = display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * factor),
      height: Math.round(display.size.height * factor)
    }
  })
  const hit = sources.find((entry) => entry.display_id === String(display.id)) ?? null
  const source = hit ?? sources[0] ?? null
  if (!source) return null

  const image = source.thumbnail
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return null

  return {
    bitmap: image.toBitmap(),
    width: size.width,
    height: size.height,
    // 别假设缩略图尺寸正好等于 scaleFactor 倍 —— 取整、等比缩放都可能掺一脚
    scale: [size.width / display.size.width, size.height / display.size.height],
    origin: [display.bounds.x, display.bounds.y],
    displays: sources.length,
    matched: hit !== null,
    image
  }
}

function sampleAt(cap: Capture, x: number, y: number): Rgb | null {
  const px = Math.round((x - cap.origin[0]) * cap.scale[0])
  const py = Math.round((y - cap.origin[1]) * cap.scale[1])
  if (px < 0 || py < 0 || px >= cap.width || py >= cap.height) return null
  return readPixel(cap.bitmap, cap.width, px, py)
}

/** 点一下胶囊（真实的 pointer 事件 —— 合成 click 走不到渲染层那段判定） */
async function clickCapsule(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(() => {
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
  })()`)
}

export async function runTopmostProbe(ctx: SmokeContext): Promise<void> {
  const owner = ctx.floatWindow()
  if (!owner || !owner.browserWindow) return

  const samples: Sample[] = []
  let savedShot = false

  // 探针会改动这几项设置：跑完必须原样还回去，否则用户下次启动看到的是被探针动过的胶囊
  const before = ctx.settings()
  const original = {
    floatAlwaysOnTop: before?.floatAlwaysOnTop ?? true,
    floatSolidBackground: before?.floatSolidBackground ?? false,
    floatSize: before?.floatSize ?? 'medium',
    floatTheme: before?.floatTheme ?? 'auto'
  }

  /** 把卡片摆成期望的开合状态 —— 盲点会因为「本来就是开的」而关掉 */
  const ensureExpanded = async (expanded: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const win = ctx.floatWindow()?.browserWindow
      if (!win || win.isDestroyed()) return
      if (ctx.floatWindow()?.isExpanded === expanded) return
      await clickCapsule(win)
      await wait(700)
    }
  }

  /** 把置顶摆成期望值；返回是否点到了那个按钮 */
  const ensurePin = async (wanted: boolean): Promise<boolean> => {
    if (ctx.settings()?.floatAlwaysOnTop === wanted) return true
    await ensureExpanded(true)
    const win = ctx.floatWindow()?.browserWindow
    if (!win || win.isDestroyed()) return false
    const clicked = (await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.card-icon.pin'); if (el) el.click(); return !!el })()`
    )) as boolean
    await wait(700)
    return clicked
  }

  /**
   * 盖一次、采一次、撤掉。
   *
   * 每次都要重新取窗口 —— 切「实心底色」会把窗口整个重建，提前抓在手里的那个
   * 引用到那时已经销毁了。
   */
  const check = async (label: string): Promise<void> => {
    // 卡片要收着：展开态下胶囊上方压着卡片，中心那个点量的就不是胶囊了
    await ensureExpanded(false)
    await wait(300)

    const win = ctx.floatWindow()?.browserWindow ?? null
    const capsule = ctx.floatState().capsule
    const settings = ctx.settings()
    if (!win || win.isDestroyed() || !capsule || !settings) {
      samples.push({
        label,
        capsuleCover: null,
        padCover: null,
        center: null,
        onTop: null,
        reported: false,
        setting: null,
        expanded: false,
        pin: null,
        at: null,
        note: '窗口或胶囊位置不可用'
      })
      return
    }

    const size = CAPSULE_SIZES[settings.floatSize]
    const centerX = Math.round(capsule.x + size.width / 2)
    const centerY = Math.round(capsule.y + size.height / 2)
    const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })
    const area = display.workArea

    // 盖板铺得比胶囊大一圈；贴到屏幕边上就顺势裁掉，别把窗口摆到屏幕外
    const bounds = {
      x: Math.max(area.x, Math.round(capsule.x) - PAD),
      y: Math.max(area.y, Math.round(capsule.y) - PAD),
      width: 0,
      height: 0
    }
    bounds.width = Math.min(area.x + area.width, Math.round(capsule.x) + size.width + PAD) - bounds.x
    bounds.height = Math.min(area.y + area.height, Math.round(capsule.y) + size.height + PAD) - bounds.y

    // 纯色参照区：盖板比胶囊多出来的那几块，取最大的一块
    const padRects = [
      { x: bounds.x, y: bounds.y, width: capsule.x - bounds.x, height: bounds.height },
      {
        x: capsule.x + size.width,
        y: bounds.y,
        width: bounds.x + bounds.width - (capsule.x + size.width),
        height: bounds.height
      },
      { x: capsule.x, y: bounds.y, width: size.width, height: capsule.y - bounds.y },
      {
        x: capsule.x,
        y: capsule.y + size.height,
        width: size.width,
        height: bounds.y + bounds.height - (capsule.y + size.height)
      }
    ].filter((rect) => rect.width >= 24 && rect.height >= 24)
    const padRect = padRects.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null

    const cover = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: false,
      backgroundColor: COVER_COLOR,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: false,
      show: false
    })

    const reported = win.isAlwaysOnTop()
    const setting = ctx.settings()?.floatAlwaysOnTop ?? null
    const pin = (await win.webContents
      .executeJavaScript(
        `document.querySelector('.card-icon.pin')?.getAttribute('aria-pressed') ?? ''`
      )
      .catch(() => '')) as string
    let center: Rgb | null = null
    let capsuleCover: number | null = null
    let padCover: number | null = null
    let info: Sample['capture']
    let note: string | undefined

    try {
      cover.show()
      cover.focus()
      await wait(200)
      /*
       * 把盖板抬到「普通窗口层的最上面」，两种常见做法都不够：
       * - 只 show()：会被前台那个最大化的应用压住，采到的参照区其实是别人的界面；
       * - show() + moveTop()：这个环境里照样抬不上来（窗口还没映射完就发了）。
       * 先置顶、再取消置顶，等于让系统用 HWND_NOTOPMOST 重新插一次 ——
       * 它稳稳落在普通窗口层最上面，同时仍在所有 topmost 窗口之下。
       * 于是这块地方只剩两种可能：胶囊压着盖板，或者盖板压着胶囊。
       */
      cover.setAlwaysOnTop(true)
      await wait(150)
      cover.setAlwaysOnTop(false)
      await wait(700)

      // 第一张丢掉：刚出现的窗口会在同一块地方留下上一帧的影子
      await capture(display)
      await wait(250)
      const cap = await capture(display)
      if (!cap) {
        note = '截屏失败'
      } else {
        info = {
          width: cap.width,
          height: cap.height,
          scale: [Number(cap.scale[0].toFixed(3)), Number(cap.scale[1].toFixed(3))],
          displays: cap.displays,
          matched: cap.matched
        }
        if (!savedShot) {
          savedShot = true
          // 只留第一张：一张整屏 PNG 将近 2MB，每轮十张纯属垃圾
          shot('probe-screen.png', cap.image)
        }
        center = sampleAt(cap, centerX, centerY)
        // 内缩 6px：胶囊自己的圆角与描边会掺进来，量的应该是它中间那片实地
        capsuleCover = coverRatio(cap, {
          x: capsule.x + 6,
          y: capsule.y + 6,
          width: size.width - 12,
          height: size.height - 12
        })
        padCover = padRect ? coverRatio(cap, padRect) : null
        if (padCover === null) note = '没有可用的纯色参照区（盖板被屏幕边缘裁没了）'
      }
    } catch (error) {
      note = `探针异常：${String(error)}`
    } finally {
      if (!cover.isDestroyed()) cover.destroy()
    }

    const sane = padCover !== null && padCover >= SANE_MIN_RATIO
    const onTop =
      sane && capsuleCover !== null ? capsuleCover < COVERED_MIN_RATIO : null
    samples.push({
      label,
      capsuleCover,
      padCover,
      center,
      onTop,
      reported,
      setting,
      expanded: ctx.floatWindow()?.isExpanded ?? false,
      pin,
      float: ctx.floatState(),
      at: [Math.round(capsule.x), Math.round(capsule.y), size.width, size.height],
      capture: info,
      note:
        note ??
        (sane ? undefined : '盖板空地里不是纯色，截图不干净（结论不可信）')
    })
    await wait(200)
  }

  try {
    // 1) 启动那一刻：present() 里 showInactive 之后补的那一刀管不管用
    await check('boot')

    // 2) 藏起来再露出来（托盘点「显示胶囊」走的就是这条路）
    owner.hide()
    await wait(300)
    owner.show()
    await wait(1400)
    await check('hide-show')

    // 3) 展开 → 收起。形状模式下这里只换 region，几何不变
    await ensureExpanded(true)
    await ensureExpanded(false)
    await wait(400)
    await check('expand-collapse')

    // 4) 卡片上的图钉：关掉之后**必须**真的能被盖住，再打开必须真的回来
    await ensurePin(false)
    await check('pin-off')
    await ensurePin(true)
    await check('pin-on')

    // 5) 主面板抢焦点时，胶囊该不该还在上面（面板是普通窗口，该在下面）
    const panel = ctx.mainWindow()
    if (panel && !panel.isDestroyed()) {
      panel.show()
      panel.focus()
      await wait(800)
      await check('panel-focus')
      panel.hide()
      await wait(300)
    }

    // 6) 切换实心底色：窗口会被销毁重建，新窗口的 topmost 有没有跟上
    ctx.patchSettings({ floatSolidBackground: true })
    await wait(1800)
    await check('solid-on')
    ctx.patchSettings({ floatSolidBackground: false })
    await wait(1800)
    await check('solid-off')

    // 7) 换尺寸档（窗口几何变了，要走一次 setBounds）
    ctx.patchSettings({ floatSize: 'large' })
    await wait(900)
    await check('size-large')
    ctx.patchSettings({ floatSize: original.floatSize })
    await wait(900)

    // 8) 换胶囊主题（实心底色那条路会 setBackgroundColor）
    ctx.patchSettings({ floatTheme: 'carbon' })
    await wait(900)
    await check('theme-carbon')
    ctx.patchSettings({ floatTheme: original.floatTheme })
    await wait(600)
  } catch (error) {
    smoke('topmost-error', { message: String(error), samples })
  } finally {
    ctx.patchSettings({ ...original })
  }

  smoke('topmost', {
    checks: samples.length,
    /*
     * 唯一的不变式：**设置说置顶，它就必须压在最上面；设置说关，它就必须能被盖住**。
     * 跟 reported 无关 —— reported 只反映 Electron 自己那份状态，正是这个探针
     * 要绕开的东西。
     */
    ok: samples.every((sample) => sample.onTop !== null && sample.onTop === sample.setting),
    failures: samples
      .filter((sample) => sample.onTop === null || sample.onTop !== sample.setting)
      .map((sample) => sample.label),
    /** 自报与事实对不上的次数：不为空就说明 isAlwaysOnTop() 不能当证据用 */
    reportedDisagrees: samples
      .filter((sample) => sample.onTop !== null && sample.onTop !== sample.reported)
      .map((sample) => sample.label),
    samples
  })
}
