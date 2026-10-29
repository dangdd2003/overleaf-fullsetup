import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildClearedSearchUrl,
  buildSearchUrl,
  readSearchUrlState,
} from '../../../frontend/js/features/gallery-search/util/search-url.ts'
import { setupRelatedTags } from '../../../frontend/js/features/gallery-page/related-tags.ts'

const BASE = 'https://overleaf.test/latex/templates'

describe('A2 gallery search URL state', function () {
  it('reads q and a 1-based page', function () {
    expect(readSearchUrlState('?q=cv&page=3')).toEqual({ query: 'cv', page: 3 })
    expect(readSearchUrlState('?q=&page=x')).toEqual({})
  })

  it('adds q and drops page for the first page', function () {
    expect(buildSearchUrl(`${BASE}?page=4`, 'cv', 1)?.href).toBe(
      `${BASE}?q=cv`
    )
  })

  it('sets page for later pages', function () {
    expect(buildSearchUrl(`${BASE}?q=cv`, 'cv', 2)?.href).toBe(
      `${BASE}?q=cv&page=2`
    )
  })

  it('returns null when the URL already matches (no history entry)', function () {
    expect(buildSearchUrl(`${BASE}?q=cv&page=2`, 'cv', 2)).toBeNull()
    expect(buildSearchUrl(`${BASE}?q=cv`, 'cv', 1)).toBeNull()
  })

  it('clears q and page', function () {
    expect(buildClearedSearchUrl(`${BASE}?q=cv&page=2&x=1`)?.href).toBe(
      `${BASE}?x=1`
    )
    expect(buildClearedSearchUrl(BASE)).toBeNull()
  })
})

function fakeElement({ scrollHeight = 0, clientHeight = 0, classes = [] } = {}) {
  const classSet = new Set(classes)
  const attributes = {}
  const listeners = {}
  return {
    scrollHeight,
    clientHeight,
    attributes,
    classList: {
      add: name => classSet.add(name),
      remove: name => classSet.delete(name),
      contains: name => classSet.has(name),
    },
    setAttribute: (name, value) => {
      attributes[name] = value
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn
    },
    click: () => listeners.click?.(),
  }
}

describe('A2 related tags show more', function () {
  let originalWindow

  beforeEach(function () {
    originalWindow = globalThis.window
    globalThis.window = {}
  })

  afterEach(function () {
    globalThis.window = originalWindow
  })

  function setup(list) {
    const container = fakeElement({ classes: ['d-none'] })
    const button = fakeElement()
    const root = {
      querySelector: selector =>
        ({
          '#more-tags-container': container,
          '#more-tags': button,
          '#related-tags': list,
        })[selector],
    }
    setupRelatedTags(root)
    return { container, button }
  }

  it('reveals the button while the list overflows and expands on click', function () {
    const list = fakeElement({ scrollHeight: 140, clientHeight: 62 })
    const { container, button } = setup(list)
    expect(container.classList.contains('d-none')).toBe(false)
    expect(button.attributes['aria-expanded']).toBe('false')

    button.click()
    expect(list.classList.contains('all-tags')).toBe(true)
    expect(button.attributes['aria-expanded']).toBe('true')
    expect(container.classList.contains('d-none')).toBe(true)
  })

  it('keeps the button hidden when all tags fit', function () {
    const list = fakeElement({ scrollHeight: 40, clientHeight: 40 })
    const { container } = setup(list)
    expect(container.classList.contains('d-none')).toBe(true)
  })

  it('does nothing on pages without related tags', function () {
    expect(() =>
      setupRelatedTags({ querySelector: () => null })
    ).not.toThrow()
  })
})
