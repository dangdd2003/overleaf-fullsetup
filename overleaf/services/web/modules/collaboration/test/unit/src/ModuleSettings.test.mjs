import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('collaboration ModuleSettings', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.COLLABORATION_ENABLED
    delete process.env.OVERLEAF_COLLABORATION_ENABLED
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  async function load({ splitTestOverrides } = {}) {
    const Settings = (await import('@overleaf/settings')).default
    delete Settings.enableCollaboration
    if (splitTestOverrides) {
      Settings.splitTestOverrides = splitTestOverrides
    } else {
      delete Settings.splitTestOverrides
    }
    const ProjectEditorHandler = (
      await import('../../../../../app/src/Features/Project/ProjectEditorHandler.mjs')
    ).default
    ProjectEditorHandler.trackChangesAvailable = false
    const EmailBuilder = (
      await import('../../../../../app/src/Features/Email/EmailBuilder.mjs')
    ).default
    delete EmailBuilder.templates.commentDigest
    await import('../../../app/src/ModuleSettings.mjs')
    return { Settings, ProjectEditorHandler, EmailBuilder }
  }

  it('is disabled by default and leaves upstream untouched', async () => {
    const { Settings, ProjectEditorHandler, EmailBuilder } = await load()
    expect(Settings.enableCollaboration).toBe(false)
    expect(ProjectEditorHandler.trackChangesAvailable).toBe(false)
    expect(Settings.splitTestOverrides).toBeUndefined()
    expect(EmailBuilder.templates.commentDigest).toBeUndefined()
  })

  it('turns everything on with COLLABORATION_ENABLED=true', async () => {
    process.env.COLLABORATION_ENABLED = 'true'
    const { Settings, ProjectEditorHandler, EmailBuilder } = await load()
    expect(Settings.enableCollaboration).toBe(true)
    expect(ProjectEditorHandler.trackChangesAvailable).toBe(true)
    expect(Settings.splitTestOverrides).toEqual({
      'email-notifications': 'enabled',
      'comment-mentions': 'enabled',
    })
    expect(EmailBuilder.templates.commentDigest).toBeDefined()
  })

  it('accepts the OVERLEAF_ prefixed variable too', async () => {
    process.env.OVERLEAF_COLLABORATION_ENABLED = 'true'
    const { Settings } = await load()
    expect(Settings.enableCollaboration).toBe(true)
  })

  it('keeps an explicit admin split test override', async () => {
    process.env.COLLABORATION_ENABLED = 'true'
    const { Settings } = await load({
      splitTestOverrides: { 'comment-mentions': 'default' },
    })
    expect(Settings.splitTestOverrides['comment-mentions']).toBe('default')
    expect(Settings.splitTestOverrides['email-notifications']).toBe('enabled')
  })
})
