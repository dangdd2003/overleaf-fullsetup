import { arxivAdapter, doiAdapter } from './scholarly.mjs'
import {
  ctanAdapter,
  githubAdapter,
  redditAdapter,
  stackexchangeAdapter,
  wikipediaAdapter,
} from './sites.mjs'

/**
 * A site adapter. match() gets the parsed URL; read() gets the same URL as a
 * string and resolves to the document, to { fallback: doc } when only a lesser
 * copy was found, or to a document with partial: true when part of it was read.
 *
 * @typedef {object} Adapter
 * @property {string} name
 * @property {(url: URL) => boolean} match
 * @property {(url: string, ctx: object) => Promise<object | { fallback: object }>} read
 */

/**
 * Site adapters: a way to read a known site through its API or a cleaner
 * view of the same page. Checked in order; the first whose match() accepts
 * the URL reads it.
 *
 * @type {Adapter[]}
 */
export const ADAPTERS = [
  arxivAdapter,
  doiAdapter,
  githubAdapter,
  wikipediaAdapter,
  stackexchangeAdapter,
  redditAdapter,
  ctanAdapter,
]

export function matchAdapter(url, adapters = ADAPTERS) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return adapters.find(adapter => adapter.match(parsed)) ?? null
}
