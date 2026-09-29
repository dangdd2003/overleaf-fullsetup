import { arxivAdapter, doiAdapter } from './scholarly.mjs'
import {
  ctanAdapter,
  githubAdapter,
  redditAdapter,
  stackexchangeAdapter,
  wikipediaAdapter,
} from './sites.mjs'

/**
 * Site adapters: a way to read a known site through its API or a cleaner
 * view of the same page. Checked in order; the first whose match() accepts
 * the URL reads it.
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
