/**
 * Images on chat requests. The equation generator sends one picture of the
 * math with its first user message; the relay checks images before anything
 * reaches a provider, and recognises a provider refusing them.
 *
 * Agent runs also carry images that tools return (view_compiled_pdf_page).
 * Those ride on the live tool message only: the stored result keeps what the
 * image is, not its bytes, so run events and chat history stay small, and a
 * conversation rebuilt for a later run has no images in it.
 */

const MAX_IMAGES_PER_REQUEST = 2
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

import {
  estimateImageTokens,
  imagePolicyFor,
} from './AiAssistImagePolicy.mjs'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function decodedBytes(data) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

const isAscii = (bytes, offset, text) =>
  bytes.toString('latin1', offset, offset + text.length) === text
// Start-of-frame markers of a JPEG: baseline, extended, progressive, lossless
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
// Base64 characters of a JPEG decoded first (48 KB); the frame header is
// nearly always in them, and a longer prefix is decoded only when it is not
const JPEG_PREFIX_CHARS = 64 * 1024

/**
 * The size in a JPEG's first frame header, walking the segments to it.
 * Undefined when the walk runs off the end of `bytes`, where a longer prefix
 * of the image may still hold the header.
 */
function jpegFrameSize(bytes) {
  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = bytes[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (JPEG_SOF.has(marker)) {
      if (pos + 9 > bytes.length) return undefined
      return {
        width: bytes.readUInt16BE(pos + 7),
        height: bytes.readUInt16BE(pos + 5),
      }
    }
    // Markers with no length: standalone, restart and start/end of image
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    pos += 2 + bytes.readUInt16BE(pos + 2)
  }
  return undefined
}

/**
 * The pixel size of a base64 image, read from its header: PNG, GIF, WebP
 * (VP8, VP8L, VP8X) or JPEG. The type comes from the bytes, not the media
 * type. Null when the header is none of those or is cut short.
 */
export function imageDimensions({ data } = {}) {
  if (typeof data !== 'string' || data.length < 32) return null
  // 64 characters are 48 bytes, past the longest header read here (WebP VP8X,
  // 30 bytes). A JPEG's frame header can sit far in, so JPEG decodes more.
  const bytes = Buffer.from(data.slice(0, 64), 'base64')
  let width = 0
  let height = 0
  if (bytes[0] === 0x89 && isAscii(bytes, 1, 'PNG') && bytes.length >= 24) {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  } else if (isAscii(bytes, 0, 'GIF8') && bytes.length >= 10) {
    width = bytes.readUInt16LE(6)
    height = bytes.readUInt16LE(8)
  } else if (isAscii(bytes, 0, 'RIFF') && isAscii(bytes, 8, 'WEBP')) {
    if (isAscii(bytes, 12, 'VP8 ') && bytes.length >= 30) {
      width = bytes.readUInt16LE(26) & 0x3fff
      height = bytes.readUInt16LE(28) & 0x3fff
    } else if (isAscii(bytes, 12, 'VP8L') && bytes.length >= 25) {
      const b1 = bytes[22]
      width = 1 + (((b1 & 0x3f) << 8) | bytes[21])
      height = 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((b1 & 0xc0) >> 6))
    } else if (isAscii(bytes, 12, 'VP8X') && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3)
      height = 1 + bytes.readUIntLE(27, 3)
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // A prefix that holds the frame header gives what the whole image would;
    // the whole image is decoded only as the last step
    for (let chars = JPEG_PREFIX_CHARS; ; chars *= 4) {
      const size = jpegFrameSize(Buffer.from(data.slice(0, chars), 'base64'))
      if (size) {
        width = size.width
        height = size.height
      }
      if (size || chars >= data.length) break
    }
  }
  return width > 0 && height > 0 ? { width, height } : null
}

export function hasImages(messages) {
  return (
    Array.isArray(messages) &&
    messages.some(
      message => Array.isArray(message?.images) && message.images.length > 0
    )
  )
}

/** Why the images of a chat request are refused; null when they are fine or absent. */
export function imageProblem(messages) {
  if (!Array.isArray(messages)) return null
  let count = 0
  for (const message of messages) {
    if (message?.images === undefined) continue
    if (!Array.isArray(message.images)) return 'Images must be a list.'
    if (message.images.length === 0) continue
    if (message.role !== 'user') return 'Images are only allowed on user messages.'
    for (const image of message.images) {
      count++
      if (count > MAX_IMAGES_PER_REQUEST) {
        return `At most ${MAX_IMAGES_PER_REQUEST} images per request.`
      }
      if (!image || typeof image !== 'object') return 'Invalid image.'
      if (!IMAGE_MEDIA_TYPES.has(image.mediaType)) return 'Unsupported image type.'
      if (typeof image.data !== 'string' || image.data.length === 0) {
        return 'Image data must be base64.'
      }
      if (image.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
        return 'Image is too large.'
      }
      if (image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
        return 'Image data must be base64.'
      }
      if (decodedBytes(image.data) > MAX_IMAGE_BYTES) return 'Image is too large.'
    }
  }
  return null
}

/** What the logs may say about a request's images: never their data. */
export function imageStats(messages) {
  if (!Array.isArray(messages)) return []
  return messages.flatMap(message =>
    Array.isArray(message?.images)
      ? message.images.map(image => ({
          mediaType: image?.mediaType,
          bytes: typeof image?.data === 'string' ? decodedBytes(image.data) : 0,
        }))
      : []
  )
}

/**
 * Tool images kept in the conversation. Each one is re-sent on every later
 * request of the run, and the model only needs the pages it is working on.
 */
const MAX_CONTEXT_IMAGES = 4

/**
 * Images past MAX_CONTEXT_IMAGES are dropped only once this many more have
 * piled up, and then all at once. Dropping one rewrites the oldest message
 * that held it, so the provider's cached prefix ends there and the rest of the
 * conversation is read again at full price. Dropping one per new image would
 * do that on every page view; this does it once per few.
 */
const CONTEXT_IMAGE_SLACK = 4

/**
 * What one image costs in context when its size is unknown. A known size is
 * priced by estimateImageTokens in AiAssistImagePolicy.mjs.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600

/**
 * Splits the image off a tool result: `result` keeps the image's description
 * (type, size, resolution) without its bytes, `images` holds what the
 * provider message carries. Accepts one `image` or a list in `images` (a
 * split page sends two). With `policy` ({ provider, model }, the run's
 * provider settings) each image also takes the provider's detail setting and
 * its token cost, which the context budget counts.
 */
export function detachToolImages(result, policy = null) {
  const list = []
  if (Array.isArray(result?.images)) list.push(...result.images)
  else if (result?.image) list.push(result.image)
  const usable = list.filter(
    image =>
      image &&
      typeof image === 'object' &&
      typeof image.data === 'string' &&
      image.data &&
      IMAGE_MEDIA_TYPES.has(image.mediaType ?? image.mimeType)
  )
  if (usable.length === 0) return { result, images: [] }

  const described = usable.map(({ data, ...rest }) => rest)
  const choice = policy
    ? imagePolicyFor({ type: policy.provider, model: policy.model })
    : null
  const images = usable.map(image => {
    const out = {
      mediaType: image.mediaType ?? image.mimeType,
      data: image.data,
    }
    const size =
      Number.isFinite(image.width) && Number.isFinite(image.height)
        ? { width: image.width, height: image.height }
        : imageDimensions(image)
    if (size) {
      out.width = size.width
      out.height = size.height
    }
    if (choice) {
      if (choice.detail) out.detail = choice.detail
      if (choice.mediaResolution) out.mediaResolution = choice.mediaResolution
      out.tokens = estimateImageTokens({
        width: out.width,
        height: out.height,
        provider: policy.provider,
        model: policy.model,
        detail: choice.mediaResolution ?? choice.detail,
      })
    }
    return out
  })

  const kept = { ...result }
  if (Array.isArray(result?.images)) kept.images = described
  if (result?.image) kept.image = described[0]
  return { result: kept, images }
}

function withoutImages(message) {
  const rest = { ...message }
  delete rest.images
  return rest
}

/**
 * Keeps the images of the newest `max` tool messages once more than
 * `max + slack` of them carry one; until then nothing changes. The text of a
 * message is left as it is (see pdfPageLines), so only the image goes.
 * Returns `messages` itself when nothing changed.
 */
export function limitContextImages(
  messages,
  max = MAX_CONTEXT_IMAGES,
  slack = CONTEXT_IMAGE_SLACK
) {
  const withImages = messages.filter(
    message => message?.role === 'tool' && message.images?.length
  ).length
  if (withImages <= max + slack) return messages
  let drop = withImages - max
  let out = messages
  // Oldest first, so the newest `max` keep their pictures
  for (let i = 0; i < messages.length && drop > 0; i++) {
    const message = messages[i]
    if (message?.role !== 'tool' || !message.images?.length) continue
    if (out === messages) out = [...messages]
    out[i] = withoutImages(message)
    drop--
  }
  return out
}

/**
 * User images a request carries: the newest ones, as many as fit in one
 * request. Long-context models read hundreds of images (Claude: 100 per
 * request, 600 with a 1M window; OpenAI: 500), but each one is re-sent on
 * every request and above 20 Claude caps their resolution, so a chat keeps
 * the newest few and the rest become a note the model can act on.
 */
export const MAX_HISTORY_IMAGES = 20

/** Most images one user message may attach. */
export const MAX_MESSAGE_IMAGES = 20

const droppedImagesNote = count =>
  `[${count} image${count === 1 ? '' : 's'} attached to this message ${count === 1 ? 'was' : 'were'} dropped from the conversation to save space. Ask the user to attach ${count === 1 ? 'it' : 'them'} again if you need to see ${count === 1 ? 'it' : 'them'}.]`

/**
 * Keeps the newest `max` images on user messages; an older message loses its
 * images and says so in its text. Deterministic for a given transcript, so a
 * rebuilt conversation stays a prefix of the cached one until a new image
 * pushes an old one out. Returns `messages` itself when nothing changed.
 */
export function limitUserImages(messages, max = MAX_HISTORY_IMAGES) {
  let kept = 0
  let out = messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user' || !message.images?.length) continue
    const room = Math.max(max - kept, 0)
    if (room >= message.images.length) {
      kept += message.images.length
      continue
    }
    if (out === messages) out = [...messages]
    // Keep the last images of the message, the ones nearest the newer turns
    const images = room > 0 ? message.images.slice(-room) : []
    kept += images.length
    const dropped = message.images.length - images.length
    const content = [message.content, droppedImagesNote(dropped)]
      .filter(part => part)
      .join('\n\n')
    out[i] = images.length
      ? { ...message, content, images }
      : { ...withoutImages(message), content }
  }
  return out
}

/**
 * Why the images one user message attaches are refused; null when they are
 * fine or absent. The per-request count of imageProblem is for the relay,
 * whose requests carry one turn; a run carries a whole chat.
 */
export function messageImagesProblem(images) {
  if (images === undefined || images === null) return null
  if (!Array.isArray(images)) return 'Images must be a list.'
  if (images.length > MAX_MESSAGE_IMAGES) {
    return `At most ${MAX_MESSAGE_IMAGES} images per message.`
  }
  for (const image of images) {
    const problem = imageProblem([{ role: 'user', images: [image] }])
    if (problem) return problem
  }
  return null
}

/** Every tool message without its images, for a model that refused them. */
export function stripToolImages(messages) {
  return messages.map(message =>
    message?.role === 'tool' && message.images?.length
      ? withoutImages(message)
      : message
  )
}

const IMAGE_REJECTION =
  /\b(?:image|images|vision|multimodal|multi-modal|image_url|inline_?data)\b/i

/** A provider refusing the images themselves: a text-only model or endpoint. */
export function isImageRejection(err) {
  const status = Number(err?.status)
  return (
    status >= 400 &&
    status < 500 &&
    ![401, 403, 408, 429].includes(status) &&
    IMAGE_REJECTION.test(String(err?.message ?? ''))
  )
}

/**
 * Generates a clean, filesystem-safe title/filename for captured or attached
 * images following best practices with date and time:
 * Overleaf_Capture_YYYY-MM-DD_HH-mm-ss.png (or Overleaf_Capture_p2_YYYY-MM-DD_HH-mm-ss.png)
 */
export function suggestCaptureTitle({
  page,
  timestamp = Date.now(),
  mediaType = 'image/png',
  prefix = 'Overleaf_Capture',
} = {}) {
  const d = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const timeStr = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const pageStr = page != null ? `_p${page}` : ''
  const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png'
  return `${prefix}${pageStr}_${dateStr}_${timeStr}.${ext}`
}
