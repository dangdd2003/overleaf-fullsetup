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
    }
  })

  afterEach(function () {
    Settings.aiAssist.enabled = origEnabled
  })

  it('registers project-scoped routes with authorization middleware', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])
    const getRoutes = webRouter.get.args.map(call => call[0])

    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs')
    expect(getRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/stream')
    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/stop')
    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/approve')
  })
})
