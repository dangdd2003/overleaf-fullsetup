import { documentFromResponse } from '../document.mjs'
import { BROWSER_HEADERS } from '../transport.mjs'
import { isoDay, webError } from '../util.mjs'

/**
 * Copies of a page kept by web archives, for when the live page cannot be
 * read or is gone. Every failure here is reported as 'network', so the
 * ladder moves on instead of stopping.
 */

const WAYBACK_LOOKUP = 'https://archive.org/wayback/available'
const ARCHIVE_TODAY = 'https://archive.ph'
/** archive.today's /newest/ redirect ends on one of these. */
const ARCHIVE_TODAY_SNAPSHOT =
  /^https:\/\/archive\.(?:ph|today|is|li|vn|fo|md)\/(?:\d{14}\/\S+|[A-Za-z0-9]{4,12})$/

function noCopy(err, message) {
  if (err?.code === 'aborted') return err
  return webError(message, { kind: 'network' })
}

/** The page's latest capture in the Internet Archive. */
export async function waybackRoute(url, { fetchPage, signal }) {
  try {
    const lookup = new URL(WAYBACK_LOOKUP)
    lookup.searchParams.set('url', url)
    const answer = await fetchPage(lookup.toString(), {
      signal,
      maxBytes: 64 * 1024,
    })
    const closest = JSON.parse(answer.body.toString('utf8'))?.archived_snapshots
      ?.closest
    const stamp =
      closest?.available && String(closest.status ?? '200') === '200'
        ? /^\d{14}$/.exec(String(closest.timestamp ?? ''))?.[0]
        : null
    if (!stamp) throw webError(`${url} has no archived copy.`)
    // id_ asks for the page as it was captured, without the archive's toolbar
    const snapshot = await fetchPage(
      `https://web.archive.org/web/${stamp}id_/${url}`,
      { signal }
    )
    return {
      ...(await documentFromResponse({ ...snapshot, url })),
      archived: isoDay(stamp),
      archiveUrl: `https://web.archive.org/web/${stamp}/${url}`,
    }
  } catch (err) {
    throw noCopy(err, err?.message || `${url} has no archived copy.`)
  }
}

/** The capture date: the latest <time datetime> on the page that is not in the future. */
function captureDay(html, now = Date.now()) {
  let latest = 0
  for (const [, value] of html.matchAll(
    /\bdatetime\s*=\s*["']([^"']+)["']/gi
  )) {
    const time = Date.parse(value)
    if (Number.isFinite(time) && time <= now && time > latest) latest = time
  }
  return latest ? new Date(latest).toISOString().slice(0, 10) : ''
}

/** The page's newest copy on archive.today, which keeps pages the Wayback Machine lacks. */
export async function archiveTodayRoute(url, { fetchPage, signal }) {
  const missing = `${url} has no archive.today copy.`
  try {
    const snapshot = await fetchPage(`${ARCHIVE_TODAY}/newest/${url}`, {
      signal,
      headers: BROWSER_HEADERS,
      impersonate: true,
    })
    if (!ARCHIVE_TODAY_SNAPSHOT.test(snapshot.url)) throw webError(missing)
    const doc = await documentFromResponse({ ...snapshot, url })
    const archived = captureDay(snapshot.body.toString('utf8'))
    return {
      ...doc,
      ...(archived ? { archived } : {}),
      archiveUrl: snapshot.url,
    }
  } catch (err) {
    throw noCopy(err, err?.status === 404 ? missing : err?.message || missing)
  }
}
