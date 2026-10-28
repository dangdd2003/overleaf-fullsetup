import Path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Settings from '@overleaf/settings'

const SETTINGS_KEYS = ['adminEmail', 'appName', 'nav', 'legalPage']

const PLACEHOLDER_EMAIL = 'placeholder@example.com'
const SOURCE_URL = 'https://github.com/dangdd2003/overleaf-fullsetup'

describe('LegalController', function () {
  const savedSettings = {}
  let LegalController

  function renderLocals() {
    const res = { render: vi.fn() }
    LegalController.renderPage({}, res)
    expect(res.render).toHaveBeenCalledTimes(1)
    return res.render.mock.calls[0][1]
  }

  beforeEach(async function () {
    for (const key of SETTINGS_KEYS) {
      savedSettings[key] = {
        has: Object.prototype.hasOwnProperty.call(Settings, key),
        value: Settings[key],
      }
    }
    vi.resetModules()
    await import('../../../app/src/ModuleSettings.mjs')
    LegalController = (await import('../../../app/src/LegalController.mjs'))
      .default
  })

  afterEach(function () {
    for (const key of SETTINGS_KEYS) {
      if (savedSettings[key].has) {
        Settings[key] = savedSettings[key].value
      } else {
        delete Settings[key]
      }
    }
  })

  it('renders the legal view with the expected locals', function () {
    Settings.appName = 'Acme Overleaf'
    Settings.adminEmail = 'admin@acme.test'
    const res = { render: vi.fn() }

    LegalController.renderPage({}, res)

    const [view, locals] = res.render.mock.calls[0]
    expect(Path.isAbsolute(view)).to.equal(true)
    expect(view).to.match(/[\\/]views[\\/]legal$/)
    expect(locals).to.deep.equal({
      title: 'Privacy & Terms',
      lastModified: '28 October 2026',
      appName: 'Acme Overleaf',
      contactEmail: 'admin@acme.test',
      sourceUrl: SOURCE_URL,
    })
  })

  describe('contactEmail', function () {
    it('uses Settings.adminEmail', function () {
      Settings.adminEmail = 'admin@acme.test'
      expect(renderLocals().contactEmail).to.equal('admin@acme.test')
    })

    it('ignores the placeholder adminEmail', function () {
      Settings.adminEmail = PLACEHOLDER_EMAIL
      expect(renderLocals().contactEmail).to.equal('')
    })

    it('returns an empty contactEmail when adminEmail is unset', function () {
      delete Settings.adminEmail
      expect(renderLocals().contactEmail).to.equal('')
    })
  })

  describe('appName', function () {
    it('uses Settings.appName when set', function () {
      Settings.appName = 'App Name'
      Settings.nav = { title: 'Nav Title' }
      expect(renderLocals().appName).to.equal('App Name')
    })

    it('falls back to Settings.nav.title when appName is unset', function () {
      delete Settings.appName
      Settings.nav = { title: 'Nav Title' }
      expect(renderLocals().appName).to.equal('Nav Title')
    })

    it('falls back to "Overleaf" when neither appName nor nav.title is set', function () {
      delete Settings.appName
      Settings.nav = {}
      expect(renderLocals().appName).to.equal('Overleaf')
    })
  })

  describe('lastModified and sourceUrl', function () {
    it('use the settings.legalPage values', function () {
      Settings.legalPage = { lastModified: '1 January 2027', sourceUrl: 'https://example.test/src' }
      const locals = renderLocals()
      expect(locals.lastModified).to.equal('1 January 2027')
      expect(locals.sourceUrl).to.equal('https://example.test/src')
    })
  })
})
