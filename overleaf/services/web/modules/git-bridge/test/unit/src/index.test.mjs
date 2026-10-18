import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import GitBridgeModule from '../../../index.mjs'
import GitBridgeRouter from '../../../app/src/GitBridgeRouter.mjs'

describe('git-bridge WebModule', () => {
  it('exposes name and router', () => {
    expect(GitBridgeModule.name).toBe('git-bridge')
    expect(typeof GitBridgeModule.router?.apply).toBe('function')
  })

  it('does nothing when GIT_BRIDGE_ENABLED is false', () => {
    const orig = Settings.enableGitBridge
    Settings.enableGitBridge = false
    try {
      const applySpy = sinon.spy(GitBridgeRouter, 'apply')
      try {
        GitBridgeModule.router.apply({}, {}, {})
        expect(applySpy.called).toBe(false)
      } finally {
        applySpy.restore()
      }
    } finally {
      Settings.enableGitBridge = orig
    }
  })

  it('delegates to GitBridgeRouter.apply when enabled', () => {
    const orig = Settings.enableGitBridge
    Settings.enableGitBridge = true
    try {
      const applySpy = sinon.spy(GitBridgeRouter, 'apply')
      try {
        const webRouter = { get: sinon.stub(), post: sinon.stub() }
        const privateApiRouter = { get: sinon.stub(), post: sinon.stub() }
        const publicApiRouter = { get: sinon.stub(), post: sinon.stub() }
        GitBridgeModule.router.apply(webRouter, privateApiRouter, publicApiRouter)
        expect(applySpy.calledOnceWith(webRouter, privateApiRouter, publicApiRouter)).toBe(true)
      } finally {
        applySpy.restore()
      }
    } finally {
      Settings.enableGitBridge = orig
    }
  })
})
