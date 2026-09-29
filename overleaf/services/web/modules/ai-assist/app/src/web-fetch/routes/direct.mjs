import { documentFromResponse } from '../document.mjs'
import { BROWSER_HEADERS } from '../transport.mjs'

/**
 * The page straight from its site, asked for the way a browser asks: many
 * sites refuse an unfamiliar user agent but serve an ordinary browser.
 */
export async function directRoute(url, { fetchPage, signal }) {
  return documentFromResponse(
    await fetchPage(url, {
      signal,
      headers: BROWSER_HEADERS,
      impersonate: true,
    })
  )
}
