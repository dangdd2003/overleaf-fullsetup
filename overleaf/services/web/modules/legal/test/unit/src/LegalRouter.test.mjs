import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('LegalRouter', function () {
  let routes
  let whitelist

  async function loadRouter() {
    vi.resetModules()
    whitelist = []
    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: {
          addEndpointToLoginWhitelist: path => whitelist.push(path),
        },
        __esModule: true,
      })
    )
    const { default: LegalRouter } =
      await import('../../../app/src/LegalRouter.mjs')
    const { default: LegalController } =
      await import('../../../app/src/LegalController.mjs')
    routes = {}
    const record =
      method =>
      (path, ...handlers) => {
        routes[`${method} ${path}`] = handlers
      }
    LegalRouter.apply({ get: record('get') })
    return LegalController
  }

  beforeEach(function () {
    vi.resetModules()
  })

  it('registers only get /legal', async function () {
    await loadRouter()
    expect(Object.keys(routes)).to.deep.equal(['get /legal'])
  })

  it('mounts /legal without login middleware', async function () {
    const LegalController = await loadRouter()
    const handlers = routes['get /legal']
    expect(handlers).to.have.lengthOf(1)
    expect(handlers[0]).to.equal(LegalController.renderPage)
  })

  it('whitelists /legal so logged-out users can open it', async function () {
    await loadRouter()
    expect(whitelist).to.deep.equal(['/legal'])
  })
})
