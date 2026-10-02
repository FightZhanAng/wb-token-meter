import type { FloatCardSide, FloatSize } from './types'

/** 胶囊本体尺寸（不含给阴影留的边距） */
export const CAPSULE_SIZES: Record<FloatSize, { width: number; height: number }> = {
  small: { width: 152, height: 44 },
  medium: { width: 198, height: 56 },
  large: { width: 252, height: 68 }
}

/**
 * 窗口比胶囊大出来的边距（单边）。
 *
 * box-shadow 画在元素外侧，如果窗口和胶囊一样大，阴影会被窗口边界裁掉，
 * 只剩右下方向的半截 —— 看起来就像胶囊外面糊了一圈底色。
 * 渲染层的 body padding 必须用同一个值，否则对不上。
 */
export const SHADOW_PAD = 12

/**
 * 展开后那张卡片的本体尺寸。
 *
 * 宽度取 272：最宽的一档胶囊是 252，卡片要比它宽松一点才像「展开出来的一层」，
 * 而不是和胶囊等宽的硬块。
 * 高度是个**常数，不是量出来的** —— 窗口尺寸得在渲染之前就知道
 * （见 floatWindowBounds），它只能是个预算值。所以 float.css 里卡片每一段
 * 文字的行高都被写死了：行高只要留一处 `normal`，这个预算就跟着字体度量飘，
 * 而量窄了的后果是**静默**的 —— 内容被 .card 的 overflow: hidden 从底部切掉，
 * 卡片看着挺正常，只是底栏不见了，没有报错也没有日志。多出来的几像素由
 * .card-spark 的 margin-top: auto 吃掉，柱子和底栏永远贴着下沿。
 *
 * 预算（float.css 里逐段对得上）：头 25 + 主读数 30 + 明细 42 + 水位 31 +
 * 七日柱 24 + 底栏 26 = 178，加五条 5px 的缝（25）、上下各 9px 的内边距（18）
 * 与两条边框（2），共 223；给到 226，余 3px。
 *
 * **动它之前先看自检报告里的 cardScroll**：clientHeight 与 scrollHeight 必须
 * 相等；同一份报告里的 sections 会告诉你这几百像素被谁吃掉了。
 */
export const FLOAT_CARD = { width: 272, height: 226 } as const

/** 卡片与胶囊之间的缝。有这条缝才看得出是两层，不是一块被压扁的方框 */
export const CARD_GAP = 8

/** 屏幕上一个矩形（workArea 与窗口 bounds 共用） */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 胶囊对应的窗口尺寸（收起态） */
export function windowSizeOf(size: FloatSize): { width: number; height: number } {
  const capsule = CAPSULE_SIZES[size]
  return {
    width: capsule.width + SHADOW_PAD * 2,
    height: capsule.height + SHADOW_PAD * 2
  }
}

/** 展开态的窗口尺寸：宽按卡片，高 = 卡片 + 缝 + 胶囊 */
export function expandedWindowSizeOf(size: FloatSize): { width: number; height: number } {
  const capsule = CAPSULE_SIZES[size]
  return {
    width: Math.max(capsule.width, FLOAT_CARD.width) + SHADOW_PAD * 2,
    height: capsule.height + CARD_GAP + FLOAT_CARD.height + SHADOW_PAD * 2
  }
}

/**
 * 卡片朝上还是朝下。
 *
 * 默认朝上 —— 胶囊默认住在屏幕右下角，上方基本总是空的，而朝下展开会盖住
 * 任务栏那一带。只有上方确实装不下、下方装得下时才翻下去。
 * 两边都装不下（屏幕特别矮）就挑宽敞的那边，宁可被裁一点也别把卡片挤出屏幕。
 */
export function floatCardSide(size: FloatSize, capsule: Point, workArea: Box): FloatCardSide {
  const need = FLOAT_CARD.height + CARD_GAP + SHADOW_PAD
  const roomAbove = capsule.y - workArea.y
  const roomBelow = workArea.y + workArea.height - (capsule.y + CAPSULE_SIZES[size].height)
  if (roomAbove >= need) return 'up'
  if (roomBelow >= need) return 'down'
  return roomAbove >= roomBelow ? 'up' : 'down'
}

/**
 * 胶囊在窗口内部的偏移。
 *
 * 横向贴哪一边按「胶囊在屏幕哪半边」定：住在右半屏就贴窗口右边，卡片往左长；
 * 住在左半屏就贴左边，卡片往右长。这样展开时胶囊**原地不动**，
 * 卡片从它旁边长出来 —— 移动的是窗口，不是用户看着的那个东西。
 */
export function capsuleOffset(opts: {
  size: FloatSize
  expanded: boolean
  side: FloatCardSide
  alignRight: boolean
}): Point {
  const { width } = CAPSULE_SIZES[opts.size]
  const win = opts.expanded ? expandedWindowSizeOf(opts.size) : windowSizeOf(opts.size)
  const cardUp = opts.expanded && opts.side === 'up'
  return {
    x: opts.alignRight ? win.width - SHADOW_PAD - width : SHADOW_PAD,
    y: cardUp ? SHADOW_PAD + FLOAT_CARD.height + CARD_GAP : SHADOW_PAD
  }
}

export interface FloatPlacement {
  bounds: Box
  /** 展开时卡片朝哪边（收起态恒为 up，渲染层不看它） */
  side: FloatCardSide
  /** 胶囊贴窗口的哪一侧 */
  alignRight: boolean
  /**
   * 胶囊落在屏幕上的位置 —— 由 bounds 反推，**已经算进了贴边收紧**。
   * 调用方拿它当唯一真相存起来，展开再收起之后胶囊才不会一格一格地漂。
   */
  capsule: Point
  /**
   * 形状模式（透明窗口）下要套在窗口上的 region；null = 恢复矩形。
   * 见 floatWindowBounds 的 shapeMode 说明。
   */
  shape: Box[] | null
}

/**
 * 由「胶囊在屏幕上的位置」算出窗口该摆在哪。收起与展开共用这一套，
 * 所以两种状态之间来回切是幂等的：origin 只由胶囊决定，与窗口大小无关。
 *
 * 贴边时窗口会被收回工作区内（否则卡片会伸到屏幕外），代价是胶囊跟着挪一点 ——
 * 这种情形只出现在用户把胶囊拖到屏幕最边上时，挪一格比卡片看不见强。
 * **允许压出去的那一圈正是 SHADOW_PAD**：它只承载阴影，被屏幕边裁掉一截看不出来，
 * 而为了它把胶囊整体挪 12px 是肉眼可见的坏处。
 */
export function floatWindowBounds(opts: {
  size: FloatSize
  /** 胶囊当前在屏幕上的位置（左上角） */
  capsule: Point
  expanded: boolean
  workArea: Box
  /**
   * 形状模式（透明窗口）：窗口**恒为展开尺寸、永不 resize**，收起态用 region
   * 把窗口裁到胶囊那一块。透明窗口 resize 会撞上 DWM 的两个毛病：
   * 新内容滞后一两百毫秒才上屏，切换的瞬间还夹一帧全空 —— 表现就是收起卡片时
   * 胶囊闪一下。region（SetWindowRgn）的裁剪是即时的，纹理不变就没有重锚问题。
   * 非透明窗口（solid 降级模式）不传它，走原来的 resize 路径。
   */
  shapeMode?: boolean
  /**
   * 收起态沿用的方向（side + 胶囊贴哪一边）。形状模式必传，且必须是**渲染层
   * 当前正在摆的那一组** —— 它的 data-side / align-items 要等 float:expanded
   * 到货才改；主进程这边先翻边，region 就罩到卡片那一块上去了。
   * 不传则按胶囊当前位置现算（首次落位、或 solid 降级模式）。
   */
  frozen?: { side: FloatCardSide; alignRight: boolean } | null
}): FloatPlacement {
  const { size, capsule, expanded, workArea, shapeMode, frozen } = opts
  const win = shapeMode ? expandedWindowSizeOf(size) : expanded ? expandedWindowSizeOf(size) : windowSizeOf(size)
  const half = workArea.x + workArea.width / 2

  /*
   * 形状模式。两条铁律，缺一条收起就会闪：
   *
   * 1) **两态的 bounds 逐像素相同**。位置一律按「展开态那一套 offset」算，
   *    收起只是多套一个 region。窗口在切换时一个像素都不动，DWM 也就没有
   *    重锚的余地 —— 只要动过（哪怕只动 1px），透明窗口就会闪。
   * 2) **方向沿用展开前那一组**（frozen 传进来）。渲染层的 data-side 与
   *    align-items 是收到 float:expanded 之后才改的；主进程这边先翻边，
   *    region 就会罩在卡片那一块上，屏幕上闪出来的正是那块方形的卡片。
   *    卡片在下（side=down）时偏移是整整一张卡片的高度，所以那边必现；
   *    跨屏幕中线拖拽时 alignRight 翻边，同样现。
   */
  if (shapeMode) {
    const cap = CAPSULE_SIZES[size]
    const side = expanded || !frozen ? floatCardSide(size, capsule, workArea) : frozen.side
    const alignRight =
      expanded || !frozen ? capsule.x + cap.width / 2 >= half : frozen.alignRight
    const offset = capsuleOffset({ size, expanded: true, side, alignRight })
    // 钳的只是胶囊本身：窗口与 region 允许压出屏幕，那一段不渲染也不吃点击
    const x = Math.round(
      Math.min(Math.max(capsule.x, workArea.x), workArea.x + workArea.width - cap.width)
    )
    const y = Math.round(
      Math.min(Math.max(capsule.y, workArea.y), workArea.y + workArea.height - cap.height)
    )
    return {
      bounds: { x: x - offset.x, y: y - offset.y, width: win.width, height: win.height },
      side,
      alignRight,
      capsule: { x, y },
      shape: expanded
        ? null
        : [
            {
              x: offset.x - SHADOW_PAD,
              y: offset.y - SHADOW_PAD,
              width: cap.width + SHADOW_PAD * 2,
              height: cap.height + SHADOW_PAD * 2
            }
          ]
    }
  }

  const side = expanded ? floatCardSide(size, capsule, workArea) : 'up'
  const alignRight = capsule.x + CAPSULE_SIZES[size].width / 2 >= half
  const offset = capsuleOffset({ size, expanded, side, alignRight })

  const minX = workArea.x - SHADOW_PAD
  const minY = workArea.y - SHADOW_PAD
  const maxX = Math.max(minX, workArea.x + workArea.width - win.width + SHADOW_PAD)
  const maxY = Math.max(minY, workArea.y + workArea.height - win.height + SHADOW_PAD)
  const x = Math.round(Math.min(maxX, Math.max(minX, capsule.x - offset.x)))
  const y = Math.round(Math.min(maxY, Math.max(minY, capsule.y - offset.y)))

  return {
    bounds: { x, y, width: win.width, height: win.height },
    side,
    alignRight,
    capsule: { x: x + offset.x, y: y + offset.y },
    shape: null
  }
}

/** 默认落点：主屏工作区右下角，离两条边各留 MARGIN */
export function defaultCapsulePosition(size: FloatSize, workArea: Box, margin: number): Point {
  const capsule = CAPSULE_SIZES[size]
  return {
    x: workArea.x + workArea.width - margin - capsule.width,
    y: workArea.y + workArea.height - margin - capsule.height
  }
}
