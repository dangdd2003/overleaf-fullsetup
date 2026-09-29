import { describe, it, vi, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import {
  getToolCategories,
  _resetCacheForTests,
} from '../../../../../app/src/Features/OAuth2/OAuth2ToolCatalog.mjs'

const SAMPLE_CATEGORIES = [
  {
    key: 'projects',
    title: 'Projects',
    tools: [
      {
        name: 'list_projects',
        title: 'List projects',
        description: 'List the projects the signed-in user can open.',
        params: [],
      },
    ],
  },
]

function mockJsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('OAuth2ToolCatalog', () => {
  let originalFetch

  beforeEach(() => {
    _resetCacheForTests()
    originalFetch = globalThis.fetch
    Settings.enableMcp = true
    Settings.mcp = { serviceUrl: 'http://mcp:3050' }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns an empty array without fetching when MCP is disabled', async () => {
    Settings.enableMcp = false
    globalThis.fetch = vi.fn()

    const categories = await getToolCategories()

    expect(categories).to.deep.equal([])
    expect(globalThis.fetch.mock.calls).to.have.length(0)
  })

  it('fetches and returns the categories reported by the MCP service', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse(200, { categories: SAMPLE_CATEGORIES })
      )

    const categories = await getToolCategories()

    expect(categories).to.deep.equal(SAMPLE_CATEGORIES)
    expect(globalThis.fetch.mock.calls[0][0]).to.equal(
      'http://mcp:3050/tools/metadata'
    )
  })

  it('caches a successful response instead of refetching', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        mockJsonResponse(200, { categories: SAMPLE_CATEGORIES })
      )

    await getToolCategories()
    await getToolCategories()

    expect(globalThis.fetch.mock.calls).to.have.length(1)
  })

  it('returns an empty array when the MCP service responds with an error status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse(500, {}))

    const categories = await getToolCategories()

    expect(categories).to.deep.equal([])
  })

  it('returns an empty array when the fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))

    const categories = await getToolCategories()

    expect(categories).to.deep.equal([])
  })
})
