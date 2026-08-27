import { describe, it, beforeEach, expect } from 'vitest'
import sinon from 'sinon'
import GitBridgeRouter from '../../../../../app/src/Features/GitBridge/GitBridgeRouter.mjs'

describe('GitBridgeRouter', function () {
  let webRouter, privateApiRouter, publicApiRouter

  beforeEach(function () {
    webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
      use: sinon.stub(),
    }
    privateApiRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
      use: sinon.stub(),
    }
    publicApiRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
      use: sinon.stub(),
    }
  })

  it('mounts all GitBridge routes onto the routers', function () {
    GitBridgeRouter.apply(webRouter, privateApiRouter, publicApiRouter)

    // Web router PAT endpoints
    expect(webRouter.post.calledWith('/user/personal-access-tokens')).toBe(true)
    expect(webRouter.get.calledWith('/user/personal-access-tokens')).toBe(true)
    expect(webRouter.delete.calledWith('/user/personal-access-tokens/:tokenId')).toBe(true)

    // OAuth2 Token endpoints
    expect(webRouter.get.calledWith('/oauth/token/info')).toBe(true)
    expect(publicApiRouter.get.calledWith('/oauth/token/info')).toBe(true)
    expect(privateApiRouter.get.calledWith('/oauth/token/info')).toBe(true)

    // Snapshot endpoints with auth and authorization
    for (const r of [webRouter, publicApiRouter, privateApiRouter]) {
      expect(r.get.calledWith('/api/v0/docs/:projectId')).toBe(true)
      expect(r.get.calledWith('/api/v0/docs/:projectId/saved_vers')).toBe(true)
      expect(r.get.calledWith('/api/v0/docs/:projectId/snapshots/:versionId')).toBe(true)
      expect(r.post.calledWith('/api/v0/docs/:projectId/snapshots')).toBe(true)
    }
  })
})
