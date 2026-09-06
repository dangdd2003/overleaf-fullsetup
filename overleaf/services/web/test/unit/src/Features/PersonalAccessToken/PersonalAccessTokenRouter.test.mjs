import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import PersonalAccessTokenRouter from '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenRouter.mjs'

describe('PersonalAccessTokenRouter', function () {
  let webRouter
  let origEnableGitBridge, origEnableMcp

  beforeEach(function () {
    origEnableGitBridge = Settings.enableGitBridge
    origEnableMcp = Settings.enableMcp
    webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
      delete: sinon.stub(),
      use: sinon.stub(),
    }
  })

  afterEach(function () {
    Settings.enableGitBridge = origEnableGitBridge
    Settings.enableMcp = origEnableMcp
  })

  it('mounts the PAT endpoints when enableGitBridge is true', function () {
    Settings.enableGitBridge = true
    Settings.enableMcp = false
    PersonalAccessTokenRouter.apply(webRouter)

    expect(webRouter.post.calledWith('/user/personal-access-tokens')).toBe(true)
    expect(webRouter.get.calledWith('/user/personal-access-tokens')).toBe(true)
    expect(
      webRouter.delete.calledWith('/user/personal-access-tokens/:tokenId')
    ).toBe(true)
  })

  it('mounts the PAT endpoints when enableMcp is true', function () {
    Settings.enableGitBridge = false
    Settings.enableMcp = true
    PersonalAccessTokenRouter.apply(webRouter)

    expect(webRouter.post.calledWith('/user/personal-access-tokens')).toBe(true)
  })

  it('does not mount any routes when both flags are falsy', function () {
    Settings.enableGitBridge = false
    Settings.enableMcp = undefined
    PersonalAccessTokenRouter.apply(webRouter)

    expect(webRouter.post.called).toBe(false)
    expect(webRouter.get.called).toBe(false)
    expect(webRouter.delete.called).toBe(false)
  })
})
