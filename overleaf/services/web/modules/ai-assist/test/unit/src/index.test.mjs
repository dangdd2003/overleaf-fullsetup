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
    // Lifecycle limits only: no keys, secrets, tokens, passwords, or endpoints.
    const { settings } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    const serialised = JSON.stringify(settings.aiAssist)
    expect(serialised).not.toMatch(/key|secret|token|password|baseUrl/i)
  })

  it('exposes a start method for background jobs', async () => {
    const { module } = await loadModule({ AI_ASSIST_ENABLED: 'true' })
    expect(module.start).toBeTypeOf('function')
  })

  it('does nothing on start when the feature is disabled', async () => {
    const { module } = await loadModule({ AI_ASSIST_ENABLED: 'false' })
    const result = await module.start()
    expect(result).toBeUndefined()
  })
})
