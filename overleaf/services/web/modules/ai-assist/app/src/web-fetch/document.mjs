import { cleanMarkdown } from './extract/markdown-clean.mjs'
import { runExtractJob } from './extract/pool.mjs'
import { assessContent } from './quality.mjs'
import { clip, collapse, webError } from './util.mjs'

/**
 * A document is kept whole, however long: the model reads it a page at a
 * time (pages.mjs), or jumps to what it needs with find (find.mjs).
 */
export {
  PAGE_CHARS,
  outline,
  pageCharsFor,
  pageMap,
  pageOf,
  pageText,
  splitPages,
} from './pages.mjs'

export function makeDocument({
  url,
  title,
  text,
  truncated = false,
  published,
  modified,
  format = 'markdown',
}) {
  let body = String(text ?? '')
  if (format === 'markdown') body = cleanMarkdown(body, url)
  body = body.trim()
  if (!body) {
    throw webError(
      `${url} has no readable text. It may need JavaScript to render.`,
      { kind: 'thin' }
    )
  }
  // Pages are cut per request, to the size of the model reading them
  return {
    url,
    title: clip(collapse(title), 200),
    text: body,
    truncated,
    ...(published ? { published } : {}),
    ...(modified ? { modified } : {}),
  }
}

function mediaType(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

function charsetOf(contentType, body) {
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '')?.[1]
  if (header) return header
  const head = body.subarray(0, 4096).toString('latin1')
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] || 'utf-8'
}

function decodeBody(body, charset) {
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

function isTextualType(type) {
  return (
    type.startsWith('text/') ||
    /(json|xml|javascript|x-tex|x-latex|x-bibtex|yaml|toml)/.test(type)
  )
}

/** Turns a fetched response into a paged document, or explains why it can't. */
export async function documentFromResponse({
  url,
  contentType = '',
  body,
  truncated = false,
}) {
  const type = mediaType(contentType)
  if (
    type === 'application/pdf' ||
    type === 'application/x-pdf' ||
    body.subarray(0, 5).toString('latin1') === '%PDF-'
  ) {
    const pdf = await runExtractJob({
      kind: 'pdf',
      body,
      url,
    }).catch(err => {
      if (truncated) {
        throw webError(`${url} was not completely downloaded before parsing.`)
      }
      throw err
    })
    return makeDocument({
      url,
      title: pdf.title,
      text: pdf.text,
      truncated: truncated || pdf.truncated,
      format: 'pdf',
    })
  }

  const text = decodeBody(body, charsetOf(contentType, body))
  const looksLikeHtml = /^\s*<(!doctype html|html|head|body)\b/i.test(text)
  if (
    type === 'text/html' ||
    type === 'application/xhtml+xml' ||
    (!type && looksLikeHtml)
  ) {
    const { markdown, ...page } = await runExtractJob({
      kind: 'html',
      html: text,
      url,
    })
    const doc = makeDocument({ url, ...page, text: markdown, truncated })
    doc.quality = assessContent({ html: text, text: markdown })
    return doc
  }

  if ((type && !isTextualType(type)) || text.includes('\u0000')) {
    throw webError(
      `${url} is ${type || 'binary data'}, not a text page, so web_fetch cannot read it.`
    )
  }
  let content = text.replace(/\r\n?/g, '\n')
  if (type.includes('json')) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      // keep the raw text
    }
  }
  return makeDocument({
    url,
    title: '',
    text: content,
    truncated,
    format: 'text',
  })
}
