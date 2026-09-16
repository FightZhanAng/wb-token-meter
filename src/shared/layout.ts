import type { FloatSize } from './types'

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

/** 胶囊对应的窗口尺寸 */
export function windowSizeOf(size: FloatSize): { width: number; height: number } {
  const capsule = CAPSULE_SIZES[size]
  return {
    width: capsule.width + SHADOW_PAD * 2,
    height: capsule.height + SHADOW_PAD * 2
  }
}
