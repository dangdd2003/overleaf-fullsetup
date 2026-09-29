import { documentFromResponse } from '../document.mjs'
import { BROWSER_HEADERS, USER_AGENT } from '../transport.mjs'
import { webError } from '../util.mjs'

/**
 * What a site adapter works with: the guarded transport for the site's API,
 * and the rest of the ladder for another URL it finds (an open-access copy).
 */
export function adapterContext({ fetchPage, signal, fresh = false, ladder }) {
  return {
    signal,
    fresh,
    ladder,
    /** GETs a page or raw file and reads it as a document. */
    readDocument: async (target, headers = BROWSER_HEADERS) =>
      documentFromResponse(
        await fetchPage(target, { signal, headers, impersonate: true })
      ),
    /** GETs a JSON API. */
    getJson: async (target, headers = {}) => {
      const response = await fetchPage(target, {
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...headers,
        },
      })
      try {
        return JSON.parse(response.body.toString('utf8'))
      } catch {
        throw webError(`${target} did not answer in JSON.`, { kind: 'network' })
      }
    },
    /** GETs a text API, such as arXiv's Atom feed. */
    getText: async (target, headers = {}) =>
      (
        await fetchPage(target, {
          signal,
          headers: { 'User-Agent': USER_AGENT, ...headers },
        })
      ).body.toString('utf8'),
  }
}

/** `**Label:** value` pairs on one line, skipping empty values. */
export function facts(pairs) {
  return pairs
    .filter(
      ([, value]) =>
        value !== undefined && value !== null && String(value).trim() !== ''
    )
    .map(([label, value]) => `**${label}:** ${value}`)
    .join(' · ')
}

const XML_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

/** Decodes XML and HTML character references in API text (titles, names). */
export function unescapeXml(text) {
  return String(text ?? '').replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity) => {
      if (entity[0] === '#') {
        const code =
          entity[1].toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : match
      }
      return XML_ENTITIES[entity.toLowerCase()] ?? match
    }
  )
}

/** Unix seconds to YYYY-MM-DD, or ''. */
export function unixDay(seconds) {
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString().slice(0, 10)
    : ''
}

/** Resolves to null when an optional lookup fails, but never hides a cancellation. */
export function optional(promise) {
  return promise.catch(err => {
    if (err?.code === 'aborted') throw err
    return null
  })
}
