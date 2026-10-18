import { describe, it, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import PersonalAccessTokenModule from '../../../index.mjs'
import PersonalAccessTokenRouter from '../../../app/src/PersonalAccessTokenRouter.mjs'

describe('personal-access-token WebModule', () => {
  it('exposes name, router, and hooks', () => {
    expect(PersonalAccessTokenModule.name).toBe('personal-access-token')
    expect(typeof PersonalAccessTokenModule.router?.apply).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.listPersonalAccessTokens).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.cleanupPersonalAccessTokens).toBe('function')
  })

  it('does not mount routes when disabled', () => {
    const origGit = Settings.enableGitBridge
    const origMcp = Settings.enableMcp
    Settings.enableGitBridge = false
    Settings.enableMcp = false
    try {
      const applySpy = sinon.spy(PersonalAccessTokenRouter, 'apply')
      try {
        PersonalAccessTokenModule.router.apply({})
        expect(applySpy.called).toBe(false)
      } finally {
        applySpy.restore()
      }
    } finally {
      Settings.enableGitBridge = origGit
      Settings.enableMcp = origMcp
    }
  })

  it('delegates to router when enabled via enableGitBridge', () => {
    const origGit = Settings.enableGitBridge
    const origMcp = Settings.enableMcp
    Settings.enableGitBridge = true
    Settings.enableMcp = false
    try {
      const applySpy = sinon.spy(PersonalAccessTokenRouter, 'apply')
      try {
        const webRouter = { get: sinon.stub(), post: sinon.stub(), delete: sinon.stub() }
        PersonalAccessTokenModule.router.apply(webRouter)
        expect(applySpy.calledOnceWith(webRouter)).toBe(true)
      } finally {
        applySpy.restore()
      }
    } finally {
      Settings.enableGitBridge = origGit
      Settings.enableMcp = origMcp
    }
  })

  it('delegates to router when enabled via enableMcp', () => {
    const origGit = Settings.enableGitBridge
    const origMcp = Settings.enableMcp
    Settings.enableGitBridge = false
    Settings.enableMcp = true
    try {
      const applySpy = sinon.spy(PersonalAccessTokenRouter, 'apply')
      try {
        const webRouter = { get: sinon.stub(), post: sinon.stub(), delete: sinon.stub() }
        PersonalAccessTokenModule.router.apply(webRouter)
        expect(applySpy.calledOnceWith(webRouter)).toBe(true)
      } finally {
        applySpy.restore()
      }
    } finally {
      Settings.enableGitBridge = origGit
      Settings.enableMcp = origMcp
    }
  })

  it('returns empty list for listPersonalAccessTokens when disabled', async () => {
    const origGit = Settings.enableGitBridge
    const origMcp = Settings.enableMcp
    Settings.enableGitBridge = false
    Settings.enableMcp = false
    try {
      const res = await PersonalAccessTokenModule.hooks.promises.listPersonalAccessTokens('user-1')
      expect(res).toEqual([])
    } finally {
      Settings.enableGitBridge = origGit
      Settings.enableMcp = origMcp
    }
  })
})
