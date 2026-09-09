import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('comment-notifications ModuleSettings', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  it('should default to disabled when env var is not set', async () => {
    delete process.env.COMMENT_NOTIFICATIONS_ENABLED
    const Settings = (await import('@overleaf/settings')).default
    // Clear any cached value
    delete Settings.enableCommentNotifications
    const mod = await import('../../../app/src/ModuleSettings.mjs')
    expect(Settings.enableCommentNotifications).toBe(false)
  })

  it('should be enabled when COMMENT_NOTIFICATIONS_ENABLED=true', async () => {
    process.env.COMMENT_NOTIFICATIONS_ENABLED = 'true'
    const Settings = (await import('@overleaf/settings')).default
    delete Settings.enableCommentNotifications
    const mod = await import('../../../app/src/ModuleSettings.mjs')
    expect(Settings.enableCommentNotifications).toBe(true)
  })

  it('should enable trackChangesAvailable when enabled', async () => {
    process.env.COMMENT_NOTIFICATIONS_ENABLED = 'true'
    const Settings = (await import('@overleaf/settings')).default
    delete Settings.enableCommentNotifications
    const ProjectEditorHandler = (
      await import('../../../../../app/src/Features/Project/ProjectEditorHandler.mjs')
    ).default
    ProjectEditorHandler.trackChangesAvailable = false
    await import('../../../app/src/ModuleSettings.mjs')
    expect(ProjectEditorHandler.trackChangesAvailable).toBe(true)
  })

  it('should not enable trackChangesAvailable when disabled', async () => {
    delete process.env.COMMENT_NOTIFICATIONS_ENABLED
    const Settings = (await import('@overleaf/settings')).default
    delete Settings.enableCommentNotifications
    const ProjectEditorHandler = (
      await import('../../../../../app/src/Features/Project/ProjectEditorHandler.mjs')
    ).default
    ProjectEditorHandler.trackChangesAvailable = false
    await import('../../../app/src/ModuleSettings.mjs')
    expect(ProjectEditorHandler.trackChangesAvailable).toBe(false)
  })
})
