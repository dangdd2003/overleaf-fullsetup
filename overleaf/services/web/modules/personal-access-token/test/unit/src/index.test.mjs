import { describe, it, expect, afterEach } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import PersonalAccessTokenModule from '../../../index.mjs'
import PersonalAccessTokenRouter from '../../../app/src/PersonalAccessTokenRouter.mjs'

describe('personal-access-token WebModule', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('exposes name, router, and hooks', () => {
    expect(PersonalAccessTokenModule.name).toBe('personal-access-token')
    expect(typeof PersonalAccessTokenModule.router?.apply).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.listPersonalAccessTokens).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.cleanupPersonalAccessTokens).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.deleteUser).toBe('function')
    expect(typeof PersonalAccessTokenModule.hooks?.promises?.expireDeletedUser).toBe('function')
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

  it('loads PersonalAccessTokenManager dynamically for listPersonalAccessTokens when enabled', async () => {
    const { default: FreshSettings } = await import('@overleaf/settings')
    const { default: FreshPatModule } = await import('../../../index.mjs')
    const { default: FreshPatManager } = await import(
      '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
    )
    const origGit = FreshSettings.enableGitBridge
    const origMcp = FreshSettings.enableMcp
    FreshSettings.enableGitBridge = false
    FreshSettings.enableMcp = true
    const stub = sinon
      .stub(FreshPatManager, 'listTokens')
      .resolves([{ _id: 'tok-1', name: 'CLI' }])
    try {
      const res = await FreshPatModule.hooks.promises.listPersonalAccessTokens('user-1')
      expect(stub.calledOnceWith('user-1')).toBe(true)
      expect(res).toEqual([{ _id: 'tok-1', name: 'CLI' }])
    } finally {
      FreshSettings.enableGitBridge = origGit
      FreshSettings.enableMcp = origMcp
    }
  })

  it('cleans up PATs on cleanupPersonalAccessTokens, deleteUser, and expireDeletedUser even when disabled', async () => {
    const { default: FreshSettings } = await import('@overleaf/settings')
    const { default: FreshPatModule } = await import('../../../index.mjs')
    const { PersonalAccessToken: FreshPatModel } = await import(
      '../../../../../app/src/models/PersonalAccessToken.mjs'
    )
    const origGit = FreshSettings.enableGitBridge
    const origMcp = FreshSettings.enableMcp
    FreshSettings.enableGitBridge = false
    FreshSettings.enableMcp = false
    const deleteManyStub = sinon
      .stub(FreshPatModel, 'deleteMany')
      .resolves({ deletedCount: 2 })
    try {
      await FreshPatModule.hooks.promises.cleanupPersonalAccessTokens('user-1')
      await FreshPatModule.hooks.promises.deleteUser('user-2')
      await FreshPatModule.hooks.promises.expireDeletedUser('user-3')
      expect(deleteManyStub.callCount).toBe(3)
      expect(deleteManyStub.getCall(0).args[0]).toEqual({ user_id: 'user-1' })
      expect(deleteManyStub.getCall(1).args[0]).toEqual({ user_id: 'user-2' })
      expect(deleteManyStub.getCall(2).args[0]).toEqual({ user_id: 'user-3' })
    } finally {
      FreshSettings.enableGitBridge = origGit
      FreshSettings.enableMcp = origMcp
    }
  })
})
