import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import {
  ADMIN_API,
  getItem,
  hydrateItem,
  listItems,
  loginRedirectUrl,
  saveCredential,
} from '../../../../frontend/js/api/client'
import { TemplateAdminApiError } from '../../../../frontend/js/api/errors'

const CSRF_TOKEN = 'test-csrf-token'

function lastRequest() {
  const call = fetchMock.callHistory.lastCall()
  if (!call?.options) {
    throw new Error('expected a fetch call with options')
  }
  return {
    url: new URL(call.url, 'https://www.test-overleaf.com'),
    headers: new Headers(call.options.headers),
    body: call.options.body,
  }
}

describe('template-gallery admin API client', function () {
  beforeEach(function () {
    window.metaAttributesCache.set('ol-csrfToken', CSRF_TOKEN)
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.delete('ol-csrfToken')
  })

  describe('requests', function () {
    it('sends the CSRF header and a JSON content type on a body request', async function () {
      fetchMock.post(`${ADMIN_API}/credentials/session`, {
        configured: true,
        updatedAt: null,
        invalid: false,
      })

      const credential = await saveCredential('cookie-value')

      const request = lastRequest()
      expect(request.headers.get('X-Csrf-Token')).to.equal(CSRF_TOKEN)
      expect(request.headers.get('Content-Type')).to.equal('application/json')
      expect(credential.configured).to.equal(true)
    })

    it('sends the sync filter as a query parameter', async function () {
      fetchMock.get(`path:${ADMIN_API}/items`, { items: [], total: 0 })

      await listItems({ sync: 'failed', page: 2 })

      const request = lastRequest()
      expect(request.url.searchParams.get('sync')).to.equal('failed')
      expect(request.url.searchParams.get('page')).to.equal('2')
    })

    it('returns the item from getItem', async function () {
      fetchMock.get(`${ADMIN_API}/items/abc`, {
        item: { id: 'abc', title: 'Sample' },
      })

      const result = await getItem('abc')

      expect(result.item.id).to.equal('abc')
    })
  })

  describe('error responses', function () {
    it('rejects a 409 with the flat error code', async function () {
      fetchMock.post(`${ADMIN_API}/items/abc/hydrate`, {
        status: 409,
        body: { error: 'source_in_progress' },
      })

      const error = await hydrateItem('abc').catch(err => err)

      expect(error).to.be.instanceOf(TemplateAdminApiError)
      expect(error.status).to.equal(409)
      expect(error.code).to.equal('source_in_progress')
    })
  })

  describe('login redirect', function () {
    it('builds the login redirect from the current path and query', function () {
      expect(
        loginRedirectUrl('/admin/templates/items/abc', '?tab=templates')
      ).to.equal(
        '/login?redirect=%2Fadmin%2Ftemplates%2Fitems%2Fabc%3Ftab%3Dtemplates'
      )
    })
  })
})
