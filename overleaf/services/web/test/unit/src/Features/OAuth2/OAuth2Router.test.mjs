import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2Router from '../../../../../app/src/Features/OAuth2/OAuth2Router.mjs'
import OAuth2MetadataController from '../../../../../app/src/Features/OAuth2/OAuth2MetadataController.mjs'
import OAuth2RegistrationController from '../../../../../app/src/Features/OAuth2/OAuth2RegistrationController.mjs'
import OAuth2AuthorizeController from '../../../../../app/src/Features/OAuth2/OAuth2AuthorizeController.mjs'
import OAuth2TokenController from '../../../../../app/src/Features/OAuth2/OAuth2TokenController.mjs'
import Settings from '@overleaf/settings'

function createMockRouter() {
  const routes = {
    get: [],
    post: [],
  }
  return {
    routes,
    get(path, ...handlers) {
      routes.get.push({ path, handlers })
    },
    post(path, ...handlers) {
      routes.post.push({ path, handlers })
    },
  }
}

describe('OAuth2Router', () => {
  let webRouter
  let privateApiRouter
  let publicApiRouter

  beforeEach(() => {
    vi.restoreAllMocks()
    webRouter = createMockRouter()
    privateApiRouter = createMockRouter()
    publicApiRouter = createMockRouter()
    Settings.enableMcp = true
  })

  it('does nothing when enableMcp is disabled', () => {
    Settings.enableMcp = false

    OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)

    expect(webRouter.routes.get).to.be.empty
    expect(webRouter.routes.post).to.be.empty
    expect(publicApiRouter.routes.get).to.be.empty
    expect(publicApiRouter.routes.post).to.be.empty
  })

  it('registers discovery endpoints on publicApiRouter and webRouter', () => {
    OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)

    const expectedDiscovery = [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/.well-known/jwks.json',
    ]

    for (const path of expectedDiscovery) {
      expect(webRouter.routes.get.some(r => r.path === path)).to.be.true
      expect(publicApiRouter.routes.get.some(r => r.path === path)).to.be.true
    }
  })

  it('registers dynamic client registration and token endpoints on publicApiRouter', () => {
    OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)

    const regRoute = publicApiRouter.routes.post.find(r => r.path === '/oauth/register')
    expect(regRoute).to.exist
    expect(regRoute.handlers).to.include(OAuth2RegistrationController.register)

    const tokenRoute = publicApiRouter.routes.post.find(r => r.path === '/oauth/token')
    expect(tokenRoute).to.exist
    expect(tokenRoute.handlers).to.include(OAuth2TokenController.token)
  })

  it('registers authorize endpoints on webRouter', () => {
    OAuth2Router.apply(webRouter, privateApiRouter, publicApiRouter)

    const authGetRoute = webRouter.routes.get.find(r => r.path === '/oauth/authorize')
    expect(authGetRoute).to.exist
    expect(authGetRoute.handlers).to.include(OAuth2AuthorizeController.showAuthorizePage)

    const authPostRoute = webRouter.routes.post.find(r => r.path === '/oauth/authorize')
    expect(authPostRoute).to.exist
    expect(authPostRoute.handlers).to.include(OAuth2AuthorizeController.handleAuthorize)
  })
})
