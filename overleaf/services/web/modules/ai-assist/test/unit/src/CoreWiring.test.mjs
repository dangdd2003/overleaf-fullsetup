import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// modules/ai-assist/test/unit/src -> services/web
const WEB_ROOT = path.resolve(import.meta.dirname, '../../../../..')

function read(relative) {
  return fs.readFileSync(path.join(WEB_ROOT, relative), 'utf8')
}

describe('ai-assist core wiring', () => {
  it('registers the module in moduleImportSequence', () => {
    expect(read('config/settings.defaults.js')).toMatch(
      /moduleImportSequence:[\s\S]*?'ai-assist'[\s\S]*?\]/
    )
  })

  it('registers every frontend slot component', () => {
    const settings = read('config/settings.defaults.js')
    for (const component of [
      'suggest-fix-button.tsx',
      'suggest-fix-panel.tsx',
      'ai-providers-widget.tsx',
      'apply-fix-listener.tsx',
    ]) {
      expect(settings, component).toContain(component)
    }
  })

  it('mounts the fix applier inside the source editor', () => {
    // useCodeMirrorViewContext throws outside its provider, so the applier has
    // to live in a source-editor slot rather than in the log-entry panel.
    const settings = read('config/settings.defaults.js')
    expect(settings).toMatch(
      /sourceEditorComponents:[\s\S]{0,300}apply-fix-listener\.tsx/
    )
  })

  it('keeps the github-sync widget alongside the new one', () => {
    // The AI widget is appended to a shared slot; it must not displace github-sync.
    const settings = read('config/settings.defaults.js')
    expect(settings).toContain('github-settings-widget.tsx')
  })

  it('points every registered slot path at a file that exists', () => {
    const settings = read('config/settings.defaults.js')
    const paths = [...settings.matchAll(/'(\.\.\/modules\/ai-assist\/[^']+)'/g)].map(
      m => m[1]
    )
    expect(paths.length).toBeGreaterThanOrEqual(3)
    for (const relative of paths) {
      const resolved = path.join(WEB_ROOT, 'config', relative)
      expect(fs.existsSync(resolved), relative).toBe(true)
    }
  })

  it('registers the rail entry in the railEntries slot', () => {
    const source = fs.readFileSync(
      path.join(WEB_ROOT, 'config/settings.defaults.js'),
      'utf8'
    )
    expect(source).toMatch(
      /ai-assist\/frontend\/js\/features\/ai-assist\/rail-entry/
    )
  })

  it('registers the right panel in the mainEditorLayoutPanels slot', () => {
    const source = fs.readFileSync(
      path.join(WEB_ROOT, 'config/settings.defaults.js'),
      'utf8'
    )
    expect(source).toMatch(
      /ai-assist\/frontend\/js\/features\/ai-assist\/components\/agent\/ai-assist-right-panel/
    )
  })

  it('adds ai-assist to the RailTabKey union', () => {
    const source = fs.readFileSync(
      path.join(
        WEB_ROOT,
        'frontend/js/features/ide-react/context/rail-context.tsx'
      ),
      'utf8'
    )
    expect(source).toMatch(/\|\s*'ai-assist'/)
  })

  it('exposes ol-aiAssistEnabled to the frontend', () => {
    expect(read('app/views/layout-base.pug')).toContain('ol-aiAssistEnabled')
    expect(read('frontend/js/utils/meta.ts')).toContain("'ol-aiAssistEnabled'")
  })

  it('includes aiAssistEnabled in haslangFeedbackLinkingWidgets', () => {
    // Controls the AI features section so the provider widget renders on CE
    // without forcing the project synchronisation section open.
    const section = read('frontend/js/features/settings/components/linking-section.tsx')
    expect(section).toContain("getMeta('ol-aiAssistEnabled')")
    expect(section).toMatch(/haslangFeedbackLinkingWidgets[\s\S]{0,300}aiAssistEnabled/)
  })

  it('leaves no AI route for nginx to special-case', () => {
    // The browser streams from the provider directly, so nothing AI-shaped ever
    // reaches this proxy and no buffering exemption is needed.
    const conf = fs.readFileSync(
      path.join(WEB_ROOT, '../../server-ce/nginx/overleaf.conf'),
      'utf8'
    )
    expect(conf).not.toContain('ai/error-assistant')
  })

  it('registers the background run router for the module', () => {
    // Server-side background runs that survive browser close and tab reload
    // route through AiAssistRunRouter.
    const source = fs.readFileSync(
      path.join(WEB_ROOT, 'modules/ai-assist/index.mjs'),
      'utf8'
    )
    expect(source).toMatch(/router\s*:/)
    expect(
      fs.existsSync(
        path.join(WEB_ROOT, 'modules/ai-assist/app/src/AiAssistRunRouter.mjs')
      )
    ).toBe(true)
  })
})
