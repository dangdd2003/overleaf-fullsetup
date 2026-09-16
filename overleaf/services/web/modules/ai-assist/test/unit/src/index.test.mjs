import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

async function loadModule(env = {}) {
  vi.resetModules()
  const original = process.env.AI_ASSIST_ENABLED
  if (env.AI_ASSIST_ENABLED === undefined) delete process.env.AI_ASSIST_ENABLED
  else process.env.AI_ASSIST_ENABLED = env.AI_ASSIST_ENABLED

  vi.doMock('@overleaf/settings', () => ({ default: {} }))

  const mod = await import('../../../index.mjs')
  const settings = (await import('@overleaf/settings')).default

  process.env.AI_ASSIST_ENABLED = original
  return { module: mod.default, settings }
}

describe('ai-assist module entry', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.doUnmock('@overleaf/settings'))

  it('names itself so Modules.mjs can find it', async () => {
    const { module } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    expect(module.name).toBe('ai-assist')
  })

  it('registers the background run router', async () => {
    const { module } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    expect(module.router).toBeDefined()
  })

  it('exposes the feature flag when enabled', async () => {
    const { settings } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    expect(settings.aiAssist.enabled).toBe(true)
  })

  it('is off unless the flag is exactly "true"', async () => {
    const { settings } = await loadModule({ AI_ASSIST_ENABLED: '1' })
    expect(settings.aiAssist.enabled).toBe(false)
  })

  it('is off when the flag is unset', async () => {
    const { settings } = await loadModule({})
    expect(settings.aiAssist.enabled).toBe(false)
  })

  it('carries no credentials or endpoints in settings', async () => {
    // Nothing server-side to configure: no key, no base URL, no quota.
    const { settings } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    expect(Object.keys(settings.aiAssist)).toEqual(['enabled'])
  })
})
