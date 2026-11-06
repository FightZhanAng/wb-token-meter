/**
 * 图标生成器 —— 纯 Node 实现，零依赖。
 *
 * 产出：
 *   resources/icon.png            256x256 应用图标（柱状计量图）
 *   resources/icon.ico            多尺寸 Windows 图标（16/24/32/48/64/128/256）
 *   resources/tray/tray-<n>.png   32x32 托盘进度环，n = 0,10,...,100
 *
 * 为什么图标也自己画：electron-builder 默认拿它的 WASM 图标工具做 png→ico 转换，
 * 那东西在内存受限环境里会直接 `WebAssembly.Memory(): could not allocate memory`
 * 把整个打包流程搞挂。自己生成 ICO 既绕开这个坑，也少一层依赖。
 * 同理不引入 sharp/canvas —— 原生模块为一个图标不值得处理 electron-rebuild。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------- 光栅化工具 */

const SS = 4 // 每像素 4x4 超采样

function rasterize(size, sampler) {
  const out = Buffer.alloc(size * size * 4)
  const total = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          const hit = sampler(px, py)
          if (hit) {
            r += hit.rgb[0] * hit.a
            g += hit.rgb[1] * hit.a
            b += hit.rgb[2] * hit.a
            a += hit.a
          }
        }
      }
      const i = (y * size + x) * 4
      if (a > 0) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
        out[i + 3] = Math.round((a / total) * 255)
      }
    }
  }
  return out
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/** 圆角矩形命中测试 */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  const dx = Math.max(x0 + r - px, 0, px - (x1 - r))
  const dy = Math.max(y0 + r - py, 0, py - (y1 - r))
  return dx * dx + dy * dy <= r * r
}

/* ---------------------------------------------------------------- ICO 编码 */

/**
 * 单帧编码成 ICO 内嵌的 BMP。
 * ICO 里的 BMP 没有文件头，直接是 BITMAPINFOHEADER；
 * 高度要写成实际高度的两倍 —— 上半是 XOR 像素，下半是 1bpp 的 AND 掩码。
 */
function encodeBmpFrame(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sourceY = size - 1 - y // BMP 自下而上
    for (let x = 0; x < size; x++) {
      const s = (sourceY * size + x) * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)
  return Buffer.concat([header, xor, mask])
}

function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  const directory = Buffer.alloc(frames.length * 16)
  let offset = 6 + frames.length * 16

  frames.forEach((frame, index) => {
    const base = index * 16
    directory[base] = frame.size >= 256 ? 0 : frame.size
    directory[base + 1] = frame.size >= 256 ? 0 : frame.size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(frame.data.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += frame.data.length
  })

  return Buffer.concat([header, directory, ...frames.map((frame) => frame.data)])
}

/* --------------------------------------------------------- 应用图标（仪表） */

/*
 * 语言和面板对齐：一片纯色卡面，中间一根仪表 —— 新界面的「上下文」仪表、
 * 胶囊水位环都是这套圆环语言，图标跟着它们走，而不是继续用旧的三根柱子。
 *
 * 四个候选先在预览模式里渲出来比，定稿后只留 use 的那一个。
 */

const WHITE = [255, 255, 255]
const BLUE_TOP = [10, 132, 255]
const BLUE_BOTTOM = [0, 98, 196]
const TRACK_LIGHT = [227, 227, 232]

/** 蓝色卡面（带一点上下渐变，纯平会在小尺寸下发死） */
function bluePlate(px, py, box = 0.06, radius = 0.2) {
  if (!inRoundRect(px, py, box, box, 1 - box, 1 - box, radius)) return null
  return { rgb: lerp(BLUE_TOP, BLUE_BOTTOM, (py - box) / (1 - 2 * box)), a: 1 }
}

/** 白色卡面 + 一圈发丝边（浅色底上不至于糊成一片） */
function whitePlate(px, py, box = 0.06, radius = 0.2) {
  if (!inRoundRect(px, py, box, box, 1 - box, 1 - box, radius)) return null
  // 发丝边是白卡在浅色底上唯一的轮廓，16px 下也得剩得下一像素，所以给到 0.012
  if (!inRoundRect(px, py, box + 0.012, box + 0.012, 1 - box - 0.012, 1 - box - 0.012, radius - 0.009)) {
    return { rgb: [211, 211, 218], a: 1 }
  }
  return { rgb: lerp([255, 255, 255], [243, 243, 247], (py - box) / (1 - 2 * box)), a: 1 }
}

/**
 * 从 12 点开始、顺时针扫过 sweepDeg 的圆弧，端点带半圆帽。
 * 圆心、内外半径都用 0~1 的比例坐标，放大到 1024 也不会糊。
 */
function arcHit(px, py, inner, outer, sweepDeg, startDeg = 0) {
  const dx = px - 0.5
  const dy = py - 0.5
  const d = Math.hypot(dx, dy)
  const mid = (inner + outer) / 2
  const band = (outer - inner) / 2
  const cap = (deg) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return Math.hypot(px - (0.5 + Math.cos(rad) * mid), py - (0.5 + Math.sin(rad) * mid)) <= band
  }
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI + 90
  if (ang < 0) ang += 360
  const inBand = d >= inner && d <= outer
  return (inBand && ang <= sweepDeg) || cap(startDeg) || cap(startDeg + sweepDeg)
}

function inBand(px, py, inner, outer) {
  const d = Math.hypot(px - 0.5, py - 0.5)
  return d >= inner && d <= outer
}

/** 指针：从圆心附近指向某个角度，末端收圆 */
function needleHit(px, py, deg, inner, outer, halfWidth) {
  const rad = ((deg - 90) * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const dx = px - 0.5
  const dy = py - 0.5
  const along = dx * ux + dy * uy
  if (along < inner || along > outer) return false
  const perp = Math.abs(dx * uy - dy * ux)
  return perp <= halfWidth
}

/* A：蓝牌 + 白环（只有环，最小元素） */
function iconRing(px, py) {
  const plate = bluePlate(px, py)
  if (!plate) return null
  if (arcHit(px, py, 0.2, 0.315, 259)) return { rgb: WHITE, a: 1 }
  // 轨道必须自己混到底色上：光栅化只认 alpha 覆盖，半透明会被合成到画布背景上
  if (inBand(px, py, 0.2, 0.315)) return { rgb: lerp(plate.rgb, WHITE, 0.26), a: 1 }
  return plate
}

/* B：蓝牌 + 白环 + 指针（读数感更强） */
function iconNeedle(px, py) {
  const plate = bluePlate(px, py)
  if (!plate) return null
  if (Math.hypot(px - 0.5, py - 0.5) <= 0.052) return { rgb: WHITE, a: 1 }
  if (needleHit(px, py, 259, 0.03, 0.17, 0.028)) return { rgb: WHITE, a: 1 }
  if (arcHit(px, py, 0.215, 0.325, 259)) return { rgb: WHITE, a: 1 }
  if (inBand(px, py, 0.215, 0.325)) return { rgb: lerp(plate.rgb, WHITE, 0.26), a: 1 }
  return plate
}

/* C：白牌 + 蓝环（最贴近「白卡 + 蓝强调」的界面） */
function iconWhitePlate(px, py) {
  const plate = whitePlate(px, py)
  if (!plate) return null
  if (arcHit(px, py, 0.205, 0.315, 259)) return { rgb: [0, 113, 227], a: 1 }
  if (inBand(px, py, 0.205, 0.315)) return { rgb: lerp(plate.rgb, TRACK_LIGHT, 0.55), a: 1 }
  return plate
}

/* D：蓝牌 + 胶囊仪表（直接搬「上下文」那根条） */
function iconPill(px, py) {
  const plate = bluePlate(px, py)
  if (!plate) return null
  const y0 = 0.435
  const y1 = 0.565
  const x0 = 0.17
  const x1 = 0.83
  if (inRoundRect(px, py, x0, y0, x1, y1, (y1 - y0) / 2)) {
    const split = x0 + (x1 - x0) * 0.72
    if (px <= split) return { rgb: WHITE, a: 1 }
    return { rgb: lerp(plate.rgb, WHITE, 0.26), a: 1 }
  }
  // 指针：70% 处一根细白线
  const nx = x0 + (x1 - x0) * 0.72
  if (Math.abs(px - nx) <= 0.012 && py >= y0 - 0.035 && py <= y1 + 0.035) {
    return { rgb: WHITE, a: 1 }
  }
  return plate
}

const APP_ICON = iconWhitePlate

/* --------------------------------------------------- 进度环（托盘图标）  */

/* 托盘跟着面板的语义色走：强调蓝 / 琥珀 / 红，和 --pen / --warn / --alarm 同值 */
const RING_TRACK = [110, 110, 115]
const RING_TRACK_ALPHA = 0.42

/** 水位越高颜色越警示：蓝 -> 琥珀 -> 红 */
function ringColor(progress) {
  if (progress >= 0.9) return [220, 38, 38]
  if (progress >= 0.7) return [234, 179, 8]
  return [0, 113, 227]
}

function ringSampler(progress) {
  const cx = 0.5
  const cy = 0.5
  const outer = 0.4375
  const inner = 0.28125
  const arc = progress * Math.PI * 2
  const accent = ringColor(progress)

  return (px, py) => {
    const dx = px - cx
    const dy = py - cy
    const d = Math.hypot(dx, dy)
    if (d < inner || d > outer) return null
    if (progress <= 0) return { rgb: RING_TRACK, a: RING_TRACK_ALPHA }
    let ang = Math.atan2(dx, -dy)
    if (ang < 0) ang += Math.PI * 2
    return ang <= arc ? { rgb: accent, a: 1 } : { rgb: RING_TRACK, a: RING_TRACK_ALPHA }
  }
}

/* ------------------------------------------------------------------ 主流程 */

const iconDir = join(ROOT, 'resources')
const trayDir = join(iconDir, 'tray')
mkdirSync(trayDir, { recursive: true })

const iconPath = join(iconDir, 'icon.png')
const iconRgba256 = rasterize(256, APP_ICON)
writeFileSync(iconPath, encodePng(256, 256, iconRgba256))

/* macOS 的 .icns 要 1024×1024 起步 —— 256 那张 electron-builder 会直接拒绝转。
   同一套 sampler 放大即可（图形是按比例定义的，不糊）。 */
const icon1024Path = join(iconDir, 'icon-1024.png')
writeFileSync(icon1024Path, encodePng(1024, 1024, rasterize(1024, APP_ICON)))

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoFrames = icoSizes.map((size) => {
  const rgba = size === 256 ? iconRgba256 : rasterize(size, APP_ICON)
  return { size, data: size >= 128 ? encodePng(size, size, rgba) : encodeBmpFrame(rgba, size) }
})
const icoPath = join(iconDir, 'icon.ico')
writeFileSync(icoPath, encodeIco(icoFrames))

for (let percent = 0; percent <= 100; percent += 10) {
  const png = encodePng(32, 32, rasterize(32, ringSampler(percent / 100)))
  writeFileSync(join(trayDir, `tray-${percent}.png`), png)
}

console.log(`icon  -> ${iconPath}`)
console.log(`icon  -> ${icon1024Path} (1024x1024, mac 的 .icns 从这张转)`)
console.log(`ico   -> ${icoPath} (${icoSizes.join('/')}, ${icoFrames.length} 帧)`)
console.log(`tray  -> ${trayDir}/tray-0..100.png (11 帧)`)

/* ------------------------------------------------------------ 候选预览 */

/** 只在 `WB_ICON_PREVIEW=1` 时跑：把四个候选排成一张对照图，方便肉眼比 16/32 像素下的可读性 */
if (process.env.WB_ICON_PREVIEW === '1') {
  const upscale = (rgba, size, factor) => {
    const out = Buffer.alloc(size * factor * size * factor * 4)
    for (let y = 0; y < size * factor; y++) {
      for (let x = 0; x < size * factor; x++) {
        const s = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4
        const d = (y * size * factor + x) * 4
        out[d] = rgba[s]
        out[d + 1] = rgba[s + 1]
        out[d + 2] = rgba[s + 2]
        out[d + 3] = rgba[s + 3]
      }
    }
    return out
  }

  const pad = 20
  const cell = 256
  const gap = 16
  const width = pad * 2 + cell * 3 + gap * 2
  const height = pad * 2 + (cell + gap) * 4 - gap
  const sheet = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    sheet[i * 4] = 245
    sheet[i * 4 + 1] = 245
    sheet[i * 4 + 2] = 247
    sheet[i * 4 + 3] = 255
  }

  const paste = (rgba, ox, oy) => {
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const s = (y * cell + x) * 4
        const a = rgba[s + 3] / 255
        if (a <= 0) continue
        const d = ((oy + y) * width + ox + x) * 4
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a))
      }
    }
  }

  const rows = [
    ['A-ring', iconRing],
    ['B-needle', iconNeedle],
    ['C-white', iconWhitePlate],
    ['D-pill', iconPill]
  ]
  rows.forEach(([, sampler], index) => {
    const oy = pad + index * (cell + gap)
    paste(rasterize(256, sampler), pad, oy)
    paste(upscale(rasterize(32, sampler), 32, 8), pad + cell + gap, oy)
    paste(upscale(rasterize(16, sampler), 16, 16), pad + (cell + gap) * 2, oy)
  })

  const previewDir = join(tmpdir(), 'icon-preview')
  mkdirSync(previewDir, { recursive: true })
  writeFileSync(join(previewDir, 'contact.png'), encodePng(width, height, sheet))
  console.log(`preview -> ${join(previewDir, 'contact.png')}`)
}

/* 同一份预览里再看一眼「深色任务栏」上的样子：白牌在深底上才显出轮廓 */
if (process.env.WB_ICON_PREVIEW === '1') {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const gap = 16
  const pad = 20
  const width = pad * 2 + sizes.reduce((a, b) => a + b, 0) + gap * (sizes.length - 1)
  const height = pad * 2 + 256
  const sheet = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    sheet[i * 4] = 29
    sheet[i * 4 + 1] = 29
    sheet[i * 4 + 2] = 31
    sheet[i * 4 + 3] = 255
  }
  let x = pad
  for (const size of sizes) {
    const rgba = rasterize(size, APP_ICON)
    const oy = pad + Math.round((256 - size) / 2)
    for (let y = 0; y < size; y++) {
      for (let px = 0; px < size; px++) {
        const s = (y * size + px) * 4
        const a = rgba[s + 3] / 255
        if (a <= 0) continue
        const d = ((oy + y) * width + x + px) * 4
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a))
      }
    }
    x += size + gap
  }
  writeFileSync(join(tmpdir(), 'icon-preview', 'strip-dark.png'), encodePng(width, height, sheet))
  console.log(`preview -> ${join(tmpdir(), 'icon-preview', 'strip-dark.png')}`)
}
