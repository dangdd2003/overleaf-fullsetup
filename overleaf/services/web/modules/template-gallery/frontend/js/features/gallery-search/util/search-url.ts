// Keeps the gallery search in sync with `?q=` and `?page=` (1-based) like the
// official widget, so searches are linkable and survive back/forward.

export type SearchUrlState = {
  query?: string
  page?: number
}

export function readSearchUrlState(
  search: string = window.location.search
): SearchUrlState {
  const params = new URLSearchParams(search)
  const state: SearchUrlState = {}
  const page = params.get('page')
  if (page !== null) {
    const parsed = parseInt(page, 10)
    if (!isNaN(parsed)) {
      state.page = parsed
    }
  }
  const query = params.get('q')
  if (query) {
    state.query = query
  }
  return state
}

// Returns the URL for a search, or null when the current URL already matches.
export function buildSearchUrl(
  href: string,
  query: string,
  page: number
): URL | null {
  const url = new URL(href)
  const current = readSearchUrlState(url.search)
  let changed = false
  if (current.query !== query) {
    url.searchParams.set('q', query)
    changed = true
  }
  if (page === 1) {
    if (url.searchParams.has('page')) {
      url.searchParams.delete('page')
      changed = true
    }
  } else if (current.page !== page) {
    url.searchParams.set('page', page.toString())
    changed = true
  }
  return changed ? url : null
}

export function buildClearedSearchUrl(href: string): URL | null {
  const url = new URL(href)
  if (!url.searchParams.has('q') && !url.searchParams.has('page')) {
    return null
  }
  url.searchParams.delete('q')
  url.searchParams.delete('page')
  return url
}

// Legacy `?addsearch=<text>` links are rewritten to `?q=<text>` on load.
export function rewriteLegacySearchParam() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('addsearch')) {
    return
  }
  const query = url.searchParams.get('addsearch') || ''
  url.searchParams.delete('addsearch')
  url.searchParams.set('q', query)
  window.history.replaceState({}, '', url)
}
