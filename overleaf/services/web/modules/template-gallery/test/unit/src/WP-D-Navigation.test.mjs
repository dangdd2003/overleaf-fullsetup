import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'

const routerApply = vi.fn()
const installNavigation = vi.fn()
const lifecycleStart = vi.fn()

vi.mock('../../../app/src/ModuleSettings.mjs', () => ({ default: {} }))
vi.mock('../../../app/src/TemplateGalleryRouter.mjs', () => ({
  default: { apply: routerApply },
}))
vi.mock('../../../app/src/Lifecycle.mjs', () => ({
  default: { installNavigation, start: lifecycleStart },
}))

const { default: TemplateGalleryModule, installHeaderNavigation } =
  await import('../../../index.mjs')

const TEMPLATES_ITEM = {
  text: 'templates',
  url: '/latex/templates',
  class: 'subdued',
  trackingKey: 'templates',
}

describe('WP-D template-gallery navigation', () => {
  let savedNav, savedEnabled

  beforeEach(() => {
    savedNav = Settings.nav
    savedEnabled = Settings.enableTemplateGallery
    Settings.nav = { header_extras: [] }
    routerApply.mockClear()
    installNavigation.mockClear()
    lifecycleStart.mockClear()
  })

  afterEach(() => {
    Settings.nav = savedNav
    Settings.enableTemplateGallery = savedEnabled
  })

  describe('installHeaderNavigation', () => {
    it('adds the official top-level Templates item', () => {
      installHeaderNavigation()
      expect(Settings.nav.header_extras).toEqual([TEMPLATES_ITEM])
    })

    it('is idempotent', () => {
      installHeaderNavigation()
      installHeaderNavigation()
      expect(Settings.nav.header_extras).toHaveLength(1)
    })

    it('does not duplicate an admin-configured /latex/templates item', () => {
      const custom = { text: 'Gallery', url: '/latex/templates' }
      Settings.nav.header_extras = [custom]
      installHeaderNavigation()
      expect(Settings.nav.header_extras).toEqual([custom])
    })

    it('places Templates before Pricing and Help like overleaf.com', () => {
      const solutions = { text: 'solutions', dropdown: [] }
      const pricing = { text: 'pricing', url: '/user/subscription/plans' }
      const help = { text: 'help_and_resources', dropdown: [] }
      Settings.nav.header_extras = [solutions, pricing, help]
      installHeaderNavigation()
      expect(Settings.nav.header_extras.map(i => i.text)).toEqual([
        'solutions',
        'templates',
        'pricing',
        'help_and_resources',
      ])
    })

    it('places Templates before a Help dropdown when there is no Pricing', () => {
      const help = { text: 'help_and_resources', dropdown: [] }
      Settings.nav.header_extras = [help]
      installHeaderNavigation()
      expect(Settings.nav.header_extras.map(i => i.text)).toEqual([
        'templates',
        'help_and_resources',
      ])
    })

    it('appends after unrelated items', () => {
      const docs = { text: 'Docs', url: 'https://docs.example.com' }
      Settings.nav.header_extras = [docs]
      installHeaderNavigation()
      expect(Settings.nav.header_extras).toEqual([docs, TEMPLATES_ITEM])
    })

    it('creates header_extras when it is missing', () => {
      Settings.nav = {}
      installHeaderNavigation()
      expect(Settings.nav.header_extras).toEqual([TEMPLATES_ITEM])
    })

    it('does not share the item object between installs', () => {
      installHeaderNavigation()
      Settings.nav.header_extras[0].text = 'mutated'
      const other = { header_extras: [] }
      installHeaderNavigation(other)
      expect(other.header_extras[0].text).toBe('templates')
    })
  })

  describe('router.apply', () => {
    it('installs nothing when the module is disabled', () => {
      Settings.enableTemplateGallery = false
      TemplateGalleryModule.router.apply({})
      expect(Settings.nav.header_extras).toEqual([])
      expect(installNavigation).not.toHaveBeenCalled()
      expect(routerApply).not.toHaveBeenCalled()
    })

    it('installs navigation and routes when enabled, before readiness', () => {
      Settings.enableTemplateGallery = true
      const webRouter = {}
      TemplateGalleryModule.router.apply(webRouter)
      expect(Settings.nav.header_extras).toEqual([TEMPLATES_ITEM])
      expect(installNavigation).toHaveBeenCalledTimes(1)
      expect(routerApply).toHaveBeenCalledWith(webRouter)
      expect(lifecycleStart).not.toHaveBeenCalled()
    })
  })
})
