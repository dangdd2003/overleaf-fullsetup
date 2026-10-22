import type { ChatImage } from '../providers/types'

/** The longest side of a page crop sent to the model, in pixels. */
export const MAX_CROP_SIDE = 1568
/** JPEG quality for crops too large to send as PNG. */
export const JPEG_QUALITY = 0.85
/** Largest base64 payload for one crop, about 500KB. */
export const MAX_ENCODED_CHARS = 500 * 1024
/** Each shrink step when a crop is still too large; a step is 80% of the side. */
const SHRINK_STEP = 0.8
const PNG_PREFIX = 'data:image/png;base64,'.length

type Size = { width: number; height: number }
type Box = { left: number; top: number; right: number; bottom: number }

/**
 * The canvas pixels under a box drawn in CSS pixels. The canvas is rendered
 * at a resolution of its own, so each axis is scaled by canvas pixels per CSS
 * pixel (`canvas.width / clientWidth`). Clamped to the canvas, never empty.
 */
export function cropPixels(box: Box, shown: Size, canvas: Size): Size & {
  x: number
  y: number
} {
  const scaleX = shown.width > 0 ? canvas.width / shown.width : 1
  const scaleY = shown.height > 0 ? canvas.height / shown.height : 1
  const x = Math.min(Math.max(Math.floor(box.left * scaleX), 0), canvas.width - 1)
  const y = Math.min(Math.max(Math.floor(box.top * scaleY), 0), canvas.height - 1)
  const right = Math.min(Math.max(Math.ceil(box.right * scaleX), x + 1), canvas.width)
  const bottom = Math.min(
    Math.max(Math.ceil(box.bottom * scaleY), y + 1),
    canvas.height
  )
  return { x, y, width: right - x, height: bottom - y }
}

/** A size scaled down so its longest side is at most `max`; never scaled up. */
export function outputSize(size: Size, max: number = MAX_CROP_SIDE): Size {
  const longest = Math.max(size.width, size.height)
  if (longest <= max) return { width: size.width, height: size.height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/** Draws the crop of `source` at `size` into a new canvas. */
function drawCrop(
  source: HTMLCanvasElement,
  pixels: Size & { x: number; y: number },
  size: Size
): HTMLCanvasElement | null {
  const out = document.createElement('canvas')
  out.width = size.width
  out.height = size.height
  const context = out.getContext('2d')
  if (!context) return null
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    source,
    pixels.x,
    pixels.y,
    pixels.width,
    pixels.height,
    0,
    0,
    size.width,
    size.height
  )
  return out
}

function encodeJpeg(canvas: HTMLCanvasElement): ChatImage {
  const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  return {
    mediaType: 'image/jpeg',
    data: jpeg.slice(jpeg.indexOf(',') + 1),
  }
}

/** PNG when it is small, otherwise JPEG; the data has no `data:` prefix. */
function encodeCanvas(canvas: HTMLCanvasElement): ChatImage {
  const png = canvas.toDataURL('image/png')
  if (png.length - PNG_PREFIX <= MAX_ENCODED_CHARS) {
    return { mediaType: 'image/png', data: png.slice(PNG_PREFIX) }
  }
  return encodeJpeg(canvas)
}

/**
 * Generates a clean, filesystem-safe title/filename for captured images following
 * best practices with date and time:
 * Overleaf_Capture_YYYY-MM-DD_HH-mm-ss.png (or Overleaf_Capture_p2_YYYY-MM-DD_HH-mm-ss.png)
 */
export function suggestCaptureTitle({
  page,
  timestamp = Date.now(),
  mediaType = 'image/png',
  prefix = 'Overleaf_Capture',
}: {
  page?: number
  timestamp?: number
  mediaType?: string
  prefix?: string
} = {}): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const timeStr = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const pageStr = page != null ? `_p${page}` : ''
  const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png'
  return `${prefix}${pageStr}_${dateStr}_${timeStr}.${ext}`
}

/**
 * The part of a rendered page under a box, as the model gets it: at most
 * MAX_CROP_SIDE on its longest side, PNG when small and JPEG otherwise, and
 * shrunk further if even the JPEG is over MAX_ENCODED_CHARS. Null when the
 * canvas cannot be read (it has no pixels yet, or the browser refuses to
 * export it).
 */
export function cropCanvas(
  canvas: HTMLCanvasElement,
  box: Box & { page?: number }
): ChatImage | null {
  try {
    if (!canvas.width || !canvas.height) return null
    const pixels = cropPixels(
      box,
      { width: canvas.clientWidth, height: canvas.clientHeight },
      { width: canvas.width, height: canvas.height }
    )
    let size = outputSize(pixels)
    let out = drawCrop(canvas, pixels, size)
    if (!out) return null
    let image = encodeCanvas(out)
    for (let step = 0; image.data.length > MAX_ENCODED_CHARS && step < 3; step++) {
      size = {
        width: Math.max(1, Math.round(size.width * SHRINK_STEP)),
        height: Math.max(1, Math.round(size.height * SHRINK_STEP)),
      }
      out = drawCrop(canvas, pixels, size)
      if (!out) return null
      image = encodeJpeg(out)
    }
    image.name = suggestCaptureTitle({
      page: box.page,
      timestamp: Date.now(),
      mediaType: image.mediaType,
    })
    return image
  } catch {
    return null
  }
}
