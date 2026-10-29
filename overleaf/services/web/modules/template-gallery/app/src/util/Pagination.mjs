// Server-rendered listing pagination, identical to the official gallery (and
// to the upstream `pagination` pug mixin it is built from): a window of up to
// four pages either side of the current one, First/Prev only after page 1,
// Next/Last only before the last page, and no navigation at all for a single
// page. Every numbered link uses `<base>/page/<n>`, including page 1; only the
// First link points at the bare base path.

export const PAGINATION_WINDOW = 4

function toPositiveInt(value) {
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * @param {object} opts
 * @param {number} opts.current 1-based page being viewed
 * @param {number} opts.total total number of pages
 * @param {string} opts.basePath listing path without a trailing slash or /page/N
 * @param {number} [opts.window]
 * @returns {null | {
 *   current: number,
 *   total: number,
 *   first: string | null,
 *   prev: string | null,
 *   leadingEllipsis: boolean,
 *   pages: Array<{ number: number, href: string, current: boolean }>,
 *   trailingEllipsis: boolean,
 *   next: string | null,
 *   last: string | null,
 * }}
 */
export function buildPagination({
  current,
  total,
  basePath,
  window = PAGINATION_WINDOW,
}) {
  const c = toPositiveInt(current)
  const n = toPositiveInt(total)
  // Out-of-range pages render the empty state instead of a navigation.
  if (n <= 1 || c < 1 || c > n) return null

  const pageHref = page => `${basePath}/page/${page}`
  const start = Math.max(1, c - window)
  const end = Math.min(n, c + window)

  const pages = []
  for (let page = start; page <= end; page++) {
    pages.push({ number: page, href: pageHref(page), current: page === c })
  }

  return {
    current: c,
    total: n,
    first: c > 1 ? basePath : null,
    prev: c > 1 ? pageHref(c - 1) : null,
    leadingEllipsis: start > 1,
    pages,
    trailingEllipsis: end < n,
    next: c < n ? pageHref(c + 1) : null,
    last: c < n ? pageHref(n) : null,
  }
}

export function totalPagesFor(count, pageSize) {
  const n = Number(count) || 0
  return n > 0 ? Math.ceil(n / pageSize) : 0
}

export default { PAGINATION_WINDOW, buildPagination, totalPagesFor }
