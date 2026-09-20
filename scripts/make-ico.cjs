#!/usr/bin/env node
/**
 * 多分辨率 ICO 生成工具
 *
 * 用法：
 *   node scripts/make-ico.cjs <源图.png> <输出.ico> [--sizes=16,24,32,48,64,128,256] [--analyze]
 *
 * 为什么需要它：Tauri 的 bundle.icon 与托盘运行态图标都要求 ICO，
 * 而在线转换站点的流程很容易下错文件（拿到中转页而不是转换结果），
 * 生成的 ICO 也常常只含单一尺寸，在高 DPI 下被拉伸发虚。
 * 这里直接产出多尺寸、32bpp 的 ICO，尺寸齐全时 Windows 会按 DPI 挑最合适的一帧。
 *
 * ICO 内部用 BMP 帧（BITMAPINFOHEADER + BGRA + AND 掩码）而不是 PNG 帧：
 * BMP 帧兼容性最好，不依赖解码器对 PNG-in-ICO 的支持。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 解码 8 位、非隔行的 PNG（支持灰度/RGB/调色板/灰度+Alpha/RGBA） */
function decodePng(buf) {
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件')

  let pos = 8
  let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0
  let palette = null, trns = null
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.slice(pos + 4, pos + 8).toString('ascii')
    const data = buf.slice(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }

  if (depth !== 8) throw new Error('仅支持 8 位深，当前为 ' + depth)
  if (interlace !== 0) throw new Error('不支持隔行扫描的 PNG')

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = channels
  const stride = w * bpp
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 0xff
    }
    prev = line
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4
      if (colorType === 6) {
        out[d] = line[x * 4]; out[d + 1] = line[x * 4 + 1]
        out[d + 2] = line[x * 4 + 2]; out[d + 3] = line[x * 4 + 3]
      } else if (colorType === 2) {
        out[d] = line[x * 3]; out[d + 1] = line[x * 3 + 1]
        out[d + 2] = line[x * 3 + 2]; out[d + 3] = 255
      } else if (colorType === 0) {
        out[d] = out[d + 1] = out[d + 2] = line[x]; out[d + 3] = 255
      } else if (colorType === 4) {
        out[d] = out[d + 1] = out[d + 2] = line[x * 2]; out[d + 3] = line[x * 2 + 1]
      } else {
        const idx = line[x]
        out[d] = palette[idx * 3]; out[d + 1] = palette[idx * 3 + 1]
        out[d + 2] = palette[idx * 3 + 2]
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255
      }
    }
  }
  return { w, h, rgba: out }
}

/** 编码 PNG（8 位 RGBA）。用于导出界面里用的位图 logo。 */
function encodePng(img) {
  const { w, h, rgba } = img
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter type 0 (None)
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }

  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = buf => {
    let r = 0xffffffff
    for (let i = 0; i < buf.length; i++) r = crcTable[(r ^ buf[i]) & 0xff] ^ (r >>> 8)
    return (r ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 统计 alpha 分布，用来判断背景是透明还是实心 */
function alphaStats(img) {
  let opaque = 0, transparent = 0, partial = 0
  const corner = []
  const at = (x, y) => {
    const d = (y * img.w + x) * 4
    return [img.rgba[d], img.rgba[d + 1], img.rgba[d + 2], img.rgba[d + 3]]
  }
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.rgba[i * 4 + 3]
    if (a === 255) opaque++
    else if (a === 0) transparent++
    else partial++
  }
  corner.push(['左上', at(0, 0)], ['右上', at(img.w - 1, 0)],
              ['左下', at(0, img.h - 1)], ['右下', at(img.w - 1, img.h - 1)])
  return { opaque, transparent, partial, total: img.w * img.h, corner }
}

/** 面积平均缩放，按 alpha 加权避免边缘发黑 */
function resize(src, nw, nh) {
  const { w, h, rgba } = src
  const out = Buffer.alloc(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh))
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * w + sx) * 4
          const al = rgba[s + 3] / 255
          r += rgba[s] * al; g += rgba[s + 1] * al; b += rgba[s + 2] * al
          a += al; n++
        }
      }
      const d = (y * nw + x) * 4
      if (a > 0) {
        out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a)
      }
      out[d + 3] = Math.round((a / n) * 255)
    }
  }
  return { w: nw, h: nh, rgba: out }
}

/** 编码一帧 32bpp BMP（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码） */
function encodeBmpFrame(img) {
  const { w, h, rgba } = img
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(w, 4)
  header.writeInt32LE(h * 2, 8) // XOR 图 + AND 掩码，高度翻倍
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB

  const xor = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4
      const d = (y * w + x) * 4
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3]
    }
  }
  // 32bpp 帧的透明度由 alpha 通道决定，AND 掩码全 0 即可
  const andStride = Math.ceil(w / 32) * 4
  return Buffer.concat([header, xor, Buffer.alloc(andStride * h)])
}

/** 组装多尺寸 ICO */
function encodeIco(images) {
  const frames = images.map(encodeBmpFrame)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = ICO
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const dirs = images.map((img, i) => {
    const e = Buffer.alloc(16)
    e[0] = img.w >= 256 ? 0 : img.w // 256 用 0 表示
    e[1] = img.h >= 256 ? 0 : img.h
    e.writeUInt16LE(1, 4)  // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(frames[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += frames[i].length
    return e
  })
  return Buffer.concat([header, ...dirs, ...frames])
}

function main() {
  const args = process.argv.slice(2)
  const analyze = args.includes('--analyze')
  const sizesArg = args.find(a => a.startsWith('--sizes='))
  const pngArg = args.find(a => a.startsWith('--png='))
  const sizes = sizesArg
    ? sizesArg.slice(8).split(',').map(s => parseInt(s, 10)).filter(n => n > 0)
    : [16, 24, 32, 48, 64, 128, 256]
  const files = args.filter(a => !a.startsWith('--'))

  if (files.length < 2 && !analyze) {
    console.error(
      '用法: node scripts/make-ico.cjs <源图.png> <输出.ico> [--sizes=16,24,...] [--analyze]\n' +
      '      node scripts/make-ico.cjs <源图.png> <输出.png> --png=256',
    )
    process.exit(1)
  }

  const src = decodePng(fs.readFileSync(files[0]))
  const stats = alphaStats(src)
  console.log(`源图: ${files[0]}  ${src.w}x${src.h}`)
  console.log(`  alpha: 不透明 ${stats.opaque} / 半透明 ${stats.partial} / 全透明 ${stats.transparent} (共 ${stats.total})`)
  console.log('  四角像素: ' + stats.corner.map(([n, c]) => `${n} rgba(${c.join(',')})`).join('  |  '))

  if (analyze) return
  if (src.w !== src.h) console.warn('  警告: 源图不是正方形，缩放后会变形')

  // --png=<边长>：导出单张位图。界面里显示的 logo 走这条路径，
  // 直接引用 900KB 的设计源图会把前端产物撑大且没必要。
  if (pngArg) {
    const size = parseInt(pngArg.slice(6), 10)
    if (!(size > 0)) throw new Error('--png 需要一个正整数边长')
    const png = encodePng(resize(src, size, size))
    fs.writeFileSync(files[1], png)
    console.log(`输出: ${files[1]}  ${png.length} bytes  ${size}x${size}`)
    return
  }

  const images = sizes.map(s => resize(src, s, s))
  const ico = encodeIco(images)
  fs.writeFileSync(files[1], ico)
  console.log(`输出: ${files[1]}  ${ico.length} bytes  尺寸: ${sizes.join('/')}`)
}

if (require.main === module) main()

module.exports = { decodePng, alphaStats, resize, encodeBmpFrame, encodeIco, encodePng }
