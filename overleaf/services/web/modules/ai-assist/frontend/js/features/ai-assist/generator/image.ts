export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** An image ready to send: base64 data without a `data:` prefix. */
export type GeneratorImage = {
  mediaType: ImageMediaType
  data: string
  name: string
  /** Bytes of the file the author gave. */
  size: number
  width: number
  height: number
}

export type ImageError = 'type' | 'size' | 'read'

export const ACCEPTED_IMAGE_TYPES: ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024

/** Why a file cannot be used, or null. */
export function imageFileProblem(file: { type: string; size: number }): ImageError | null {
  if (!(ACCEPTED_IMAGE_TYPES as string[]).includes(file.type)) return 'type'
  if (file.size > MAX_IMAGE_FILE_BYTES) return 'size'
  return null
}

/** The first image on the clipboard, if any. */
export function imageFromClipboard(
  data: { items?: ArrayLike<DataTransferItem>; files?: ArrayLike<File> } | null
): File | null {
  if (!data) return null
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return Array.from(data.files ?? []).find(file => file.type.startsWith('image/')) ?? null
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export const MAX_LONG_EDGE = 1568
export const MIN_LONG_EDGE = 768
export const PNG_LIMIT_BYTES = 1.5 * 1024 * 1024
export const JPEG_QUALITY = 0.92

/** Long edge at most 1568 px; small crops scaled up to 768 px, since models misread tiny glyphs. */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  const scale =
    long > MAX_LONG_EDGE ? MAX_LONG_EDGE / long : long < MIN_LONG_EDGE ? MIN_LONG_EDGE / long : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Whether any pixel is transparent, and the mean luminance (0–1) of the mostly opaque ones. */
export function inkStats(pixels: ArrayLike<number>): {
  transparent: boolean
  meanLuminance: number
} {
  let transparent = false
  let sum = 0
  let count = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    if (alpha < 255) transparent = true
    if (alpha >= 128) {
      sum += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255
      count++
    }
  }
  return { transparent, meanLuminance: count > 0 ? sum / count : 0 }
}

/**
 * What to put under transparent pixels: white under dark ink, black under
 * light ink (a dark-mode screenshot), so the math stays visible. Null when
 * the image is opaque.
 */
export function backgroundFor(stats: { transparent: boolean; meanLuminance: number }): string | null {
  if (!stats.transparent) return null
  return stats.meanLuminance > 0.6 ? '#000000' : '#ffffff'
}

export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export class ImageReadError extends Error {
  code: ImageError

  constructor(code: ImageError) {
    super(code)
    this.name = 'ImageReadError'
    this.code = code
  }
}

/**
 * The image as the model gets it: resized, transparency flattened, PNG (or
 * JPEG when the PNG is large). Throws `ImageReadError`.
 */
export async function normalizeImage(file: File): Promise<GeneratorImage> {
  const problem = imageFileProblem(file)
  if (problem) throw new ImageReadError(problem)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageReadError('read')
  }
  const size = targetSize(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new ImageReadError('read')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  bitmap.close?.()

  const background = backgroundFor(
    inkStats(context.getImageData(0, 0, size.width, size.height).data)
  )
  if (background) {
    // Under what is drawn, not over it
    context.globalCompositeOperation = 'destination-over'
    context.fillStyle = background
    context.fillRect(0, 0, size.width, size.height)
    context.globalCompositeOperation = 'source-over'
  }

  let mediaType: ImageMediaType = 'image/png'
  let dataUrl = canvas.toDataURL('image/png')
  if (base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1)) > PNG_LIMIT_BYTES) {
    mediaType = 'image/jpeg'
    dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  }
  return {
    mediaType,
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    name: file.name || 'pasted-image.png',
    size: file.size,
    width: size.width,
    height: size.height,
  }
}
