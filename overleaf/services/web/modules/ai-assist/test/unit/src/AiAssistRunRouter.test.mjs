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
    const origEnv = process.env.AI_ASSIST_WEB_TOOLS_ENABLED
    try {
      process.env.AI_ASSIST_WEB_TOOLS_ENABLED = 'false'
      Settings.aiAssist.webToolsEnabled = false
      await routerModule.apply(webRouter)
      let postRoutes = webRouter.post.args.map(call => call[0])
      expect(postRoutes).not.to.include(
        '/ai-assist/projects/:Project_id/web-tools'
      )

      webRouter.post.resetHistory()
      // The first apply imported ModuleSettings.mjs, which rebuilds
      // Settings.aiAssist from the environment
      process.env.AI_ASSIST_WEB_TOOLS_ENABLED = 'true'
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
      if (origEnv !== undefined) {
        process.env.AI_ASSIST_WEB_TOOLS_ENABLED = origEnv
      } else {
        delete process.env.AI_ASSIST_WEB_TOOLS_ENABLED
      }
    }
  })

  it('registers server-side provider routes', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])

    expect(postRoutes).to.include('/ai-assist/providers/models')
    expect(postRoutes).to.include('/ai-assist/providers/test')
    expect(postRoutes).to.include('/ai-assist/providers/chat')
    expect(postRoutes).to.include('/ai-assist/providers/editor')
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

  it('registers checkpoint and rewind routes with write authorization', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])
    expect(postRoutes).to.include(
      '/ai-assist/projects/:Project_id/chats/:chatId/rewind/check'
    )
    expect(postRoutes).to.include(
      '/ai-assist/projects/:Project_id/chats/:chatId/rewind'
    )
    const checkRoute = webRouter.post.args.find(
      call =>
        call[0] ===
        '/ai-assist/projects/:Project_id/chats/:chatId/rewind/check'
    )
    expect(checkRoute).to.have.length(4)
    const rewindRoute = webRouter.post.args.find(
      call =>
        call[0] === '/ai-assist/projects/:Project_id/chats/:chatId/rewind'
    )
    expect(rewindRoute).to.have.length(4)
    const forkRoute = webRouter.post.args.find(
      call =>
        call[0] ===
        '/ai-assist/projects/:Project_id/chats/:chatId/checkpoints/fork'
    )
    expect(forkRoute).to.have.length(4)
  })
})

describe('AiAssistRunRouter async handlers', function () {
  it('passes a rejected controller promise to next instead of leaving the request hanging', async function () {
    const { default: AiAssistRunController } = await import(
      '../../../app/src/AiAssistRunController.mjs'
    )
    // Set after the import: ModuleSettings rebuilds aiAssist when it loads
    const origEnabled = Settings.aiAssist?.enabled
    Settings.aiAssist = { ...(Settings.aiAssist || {}), enabled: true }
    const stopRun = sinon
      .stub(AiAssistRunController, 'stopRun')
      .rejects(new Error('boom'))
    try {
      const webRouter = {
        get: sinon.stub(),
        post: sinon.stub(),
        put: sinon.stub(),
        patch: sinon.stub(),
        delete: sinon.stub(),
      }
      await routerModule.apply(webRouter)
      const route = webRouter.post.args.find(
        call => call[0] === '/ai-assist/projects/:Project_id/runs/:runId/stop'
      )
      const handler = route.at(-1)
      const error = await new Promise(resolve => {
        handler({ params: {}, session: {} }, {}, resolve)
      })
      expect(error.message).to.equal('boom')
      expect(stopRun.called).to.be.true
    } finally {
      stopRun.restore()
      Settings.aiAssist.enabled = origEnabled
    }
  }, 20000)
})
