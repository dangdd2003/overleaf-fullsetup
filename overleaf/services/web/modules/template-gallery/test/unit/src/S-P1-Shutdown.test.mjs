import { describe, it, expect, vi } from 'vitest'
import Settings from '@overleaf/settings'

vi.mock('../../../../../app/src/infrastructure/GracefulShutdown.mjs', () => ({
  addRequiredCleanupHandlerBeforeDrainingConnections: vi.fn(),
}))
vi.mock('../../../app/src/ModuleSettings.mjs', () => ({ default: {} }))
vi.mock('../../../app/src/TemplateGalleryRouter.mjs', () => ({
  default: { apply: vi.fn() },
}))
vi.mock('../../../app/src/Lifecycle.mjs', () => ({
  default: {
    installNavigation: vi.fn(),
    start: vi.fn(async () => ({})),
    stop: vi.fn(async () => {}),
  },
}))

const { default: TemplateGalleryModule } = await import('../../../index.mjs')
const GracefulShutdown =
  await import('../../../../../app/src/infrastructure/GracefulShutdown.mjs')
const { default: Lifecycle } = await import('../../../app/src/Lifecycle.mjs')

describe('template-gallery shutdown wiring (S-P1)', () => {
  it('registers nothing while the module is disabled', async () => {
    Settings.enableTemplateGallery = false

    await TemplateGalleryModule.start()

    expect(
      GracefulShutdown.addRequiredCleanupHandlerBeforeDrainingConnections
    ).not.toHaveBeenCalled()
    expect(Lifecycle.start).not.toHaveBeenCalled()
  })

  it('registers one required cleanup handler when enabled, and it stops the module', async () => {
    Settings.enableTemplateGallery = true

    await TemplateGalleryModule.start()
    await TemplateGalleryModule.start()

    const register =
      GracefulShutdown.addRequiredCleanupHandlerBeforeDrainingConnections
    expect(register).toHaveBeenCalledTimes(1)
    const [label, handler] = register.mock.calls[0]
    expect(label).toBe('template-gallery')

    await handler()
    expect(Lifecycle.stop).toHaveBeenCalledTimes(1)
    expect(Lifecycle.start).toHaveBeenCalledTimes(2)
  })
})
