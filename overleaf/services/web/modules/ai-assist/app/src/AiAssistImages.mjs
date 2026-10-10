/**
 * Images on chat requests. The equation generator sends one picture of the
 * math with its first user message; the relay checks images before anything
 * reaches a provider, and recognises a provider refusing them.
 */

export const MAX_IMAGES_PER_REQUEST = 2
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

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
