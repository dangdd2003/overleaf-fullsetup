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

export const MAX_IMAGES_PER_REQUEST = 2
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const IMAGE_MEDIA_TYPES = new Set([
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
export const MAX_CONTEXT_IMAGES = 4

/**
 * Images past MAX_CONTEXT_IMAGES are dropped only once this many more have
 * piled up, and then all at once. Dropping one rewrites the oldest message
 * that held it, so the provider's cached prefix ends there and the rest of the
 * conversation is read again at full price. Dropping one per new image would
 * do that on every page view; this does it once per few.
 */
export const CONTEXT_IMAGE_SLACK = 4

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
    if (Number.isFinite(image.width) && Number.isFinite(image.height)) {
      out.width = image.width
      out.height = image.height
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
