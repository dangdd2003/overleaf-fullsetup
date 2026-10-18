import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import McpModule from '../../../index.mjs'
import McpRouter from '../../../app/src/McpRouter.mjs'
import OAuth2Router from '../../../app/src/OAuth2/OAuth2Router.mjs'

describe('mcp WebModule', () => {
  it('exposes name and router', () => {
    expect(McpModule.name).toBe('mcp')
    expect(typeof McpModule.router?.apply).toBe('function')
  })

  it('does nothing when MCP_ENABLED is false', () => {
    const orig = Settings.enableMcp
    Settings.enableMcp = false
    try {
      const mcpSpy = sinon.spy(McpRouter, 'apply')
      const oauthSpy = sinon.spy(OAuth2Router, 'apply')
      try {
        McpModule.router.apply({}, {}, {})
        expect(mcpSpy.called).toBe(false)
        expect(oauthSpy.called).toBe(false)
      } finally {
        mcpSpy.restore()
        oauthSpy.restore()
      }
    } finally {
      Settings.enableMcp = orig
    }
  })

  it('delegates to McpRouter and OAuth2Router when enabled', () => {
    const orig = Settings.enableMcp
    Settings.enableMcp = true
    try {
      const mcpSpy = sinon.spy(McpRouter, 'apply')
      const oauthSpy = sinon.spy(OAuth2Router, 'apply')
      try {
        const webRouter = { get: sinon.stub(), post: sinon.stub(), patch: sinon.stub(), delete: sinon.stub() }
        const privateApiRouter = { get: sinon.stub(), post: sinon.stub(), patch: sinon.stub(), delete: sinon.stub() }
        const publicApiRouter = { get: sinon.stub(), post: sinon.stub(), patch: sinon.stub(), delete: sinon.stub(), use: sinon.stub() }
        McpModule.router.apply(webRouter, privateApiRouter, publicApiRouter)
        expect(mcpSpy.calledOnceWith(webRouter, privateApiRouter, publicApiRouter)).toBe(true)
        expect(oauthSpy.calledOnceWith(webRouter, privateApiRouter, publicApiRouter)).toBe(true)
      } finally {
        mcpSpy.restore()
        oauthSpy.restore()
      }
    } finally {
      Settings.enableMcp = orig
    }
  })
})
