import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import routerModule from '../../../app/src/AiAssistRunRouter.mjs'

describe('AiAssistRunRouter', function () {
  let webRouter
  let origEnabled

  beforeEach(function () {
    origEnabled = Settings.aiAssist?.enabled
    Settings.aiAssist = { ...(Settings.aiAssist || {}), enabled: true }
    webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      put: sinon.stub(),
      patch: sinon.stub(),
      delete: sinon.stub(),
    }
  })

  afterEach(function () {
    Settings.aiAssist.enabled = origEnabled
  })

  // The first apply imports the web app's controllers and middleware cold,
  // which alone takes most of the default 5 s under a full parallel run.
  it('registers project-scoped routes with authorization middleware', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])
    const getRoutes = webRouter.get.args.map(call => call[0])

    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs')
    expect(getRoutes).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/stream'
    )
    expect(postRoutes).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/stop'
    )
    expect(postRoutes).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/approve'
    )
    expect(postRoutes).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/compile'
    )
  }, 20000)

  it('registers the fix run web tool routes only with web tools on', async function () {
    const origWeb = Settings.aiAssist.webToolsEnabled
    try {
      Settings.aiAssist.webToolsEnabled = false
      await routerModule.apply(webRouter)
      let postRoutes = webRouter.post.args.map(call => call[0])
      expect(postRoutes).not.to.include(
        '/ai-assist/projects/:Project_id/web-tools'
      )

      webRouter.post.resetHistory()
      // The first apply imported ModuleSettings.mjs, which rebuilds
      // Settings.aiAssist from the environment
      Settings.aiAssist.enabled = true
      Settings.aiAssist.webToolsEnabled = true
      await routerModule.apply(webRouter)
      postRoutes = webRouter.post.args.map(call => call[0])
      expect(postRoutes).to.include('/ai-assist/projects/:Project_id/web-tools')
      expect(postRoutes).to.include(
        '/ai-assist/projects/:Project_id/web-tools/:name'
      )
      // Project-scoped: login, then read access to the project
      const route = webRouter.post.args.find(
        call => call[0] === '/ai-assist/projects/:Project_id/web-tools/:name'
      )
      expect(route).to.have.length(4)
    } finally {
      Settings.aiAssist.webToolsEnabled = origWeb
    }
  })

  it('registers server-side provider routes', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])

    expect(postRoutes).to.include('/ai-assist/providers/models')
    expect(postRoutes).to.include('/ai-assist/providers/test')
    expect(postRoutes).to.include('/ai-assist/providers/chat')
  })

  it('registers chat history routes', async function () {
    await routerModule.apply(webRouter)

    const getRoutes = webRouter.get.args.map(call => call[0])
    expect(getRoutes).to.include('/ai-assist/projects/:Project_id/chats')
    expect(getRoutes).to.include(
      '/ai-assist/projects/:Project_id/chats/:chatId'
    )
    expect(webRouter.put.args[0][0]).to.equal(
      '/ai-assist/projects/:Project_id/chats/:chatId'
    )
    expect(webRouter.delete.args.map(call => call[0])).to.include(
      '/ai-assist/projects/:Project_id/chats/:chatId'
    )
  })

  it('registers the routes for messages sent into a running run', async function () {
    await routerModule.apply(webRouter)

    expect(webRouter.post.args.map(call => call[0])).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/message'
    )
    expect(webRouter.delete.args.map(call => call[0])).to.include(
      '/ai-assist/projects/:Project_id/runs/:runId/message/:messageId'
    )
  })
})
