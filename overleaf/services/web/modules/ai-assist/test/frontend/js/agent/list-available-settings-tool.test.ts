import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { listAvailableSettingsTool } from '../../../../frontend/js/features/ai-assist/agent/tools/list-available-settings'
import { createFakeHandle } from './helpers/fake-handle'

describe('list_available_settings tool', function () {
  it('registers list_available_settings in toolSpecs', function () {
    const names = toolSpecs().map(s => s.name)
    expect(names).to.include('list_available_settings')
  })

  it('is marked non-mutating and non-suspending', function () {
    expect(listAvailableSettingsTool.mutates).to.be.false
    expect(listAvailableSettingsTool.suspends).to.be.false
  })

  it('executes and returns available options', async function () {
    const { handle, calls } = createFakeHandle({
      availableSettings: {
        compilers: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
        imageNames: [
          { imageName: 'texlive-2024.1', imageDesc: 'TeX Live 2024', default: true },
          { imageName: 'texlive-2023.1', imageDesc: 'TeX Live 2023' },
        ],
        spellCheckLanguages: [
          { code: 'en', name: 'English' },
          { code: 'fr', name: 'French' },
          { code: 'de', name: 'German' },
        ],
        editorModes: ['none', 'vim', 'emacs'],
        overallThemes: ['system', 'light', 'dark'],
        editorThemes: [
          { name: 'cobalt', dark: true },
          { name: 'dracula', dark: true },
          { name: 'monokai', dark: true },
        ],
        fontFamilies: [
          { name: 'monaco', label: 'Monaco / Menlo / Consolas' },
          { name: 'lucida', label: 'Lucida / Source Code Pro' },
        ],
        lineHeights: ['compact', 'normal', 'spacious'],
        fontSizes: [10, 11, 12, 13, 14, 16, 18, 20, 24],
        pdfViewers: ['pdfjs', 'native'],
      },
    })

    const res: any = await TOOLS.list_available_settings.execute({}, handle)
    expect(res.status).to.equal('ok')
    expect(res.options.compilers).to.include.members(['pdflatex', 'xelatex'])
    expect(res.options.imageNames).to.have.lengthOf(2)
    expect(res.options.editorModes).to.include('vim')
    expect(res.options.overallThemes).to.include('dark')
    expect(res.options.editorThemes).to.deep.include({ name: 'dracula', dark: true })

    expect(calls.filter(c => c.name === 'listAvailableSettings')).to.have.lengthOf(1)

    const rendered = listAvailableSettingsTool.render?.(res)
    expect(rendered).to.include('Compilers: pdflatex, latex, xelatex, lualatex')
    expect(rendered).to.include('TeX Live Versions: texlive-2024.1, texlive-2023.1')
    expect(rendered).to.include('Keybinding Modes: none, vim, emacs')
    expect(rendered).to.include('Editor Themes: cobalt, dracula, monokai')
    expect(rendered).to.include('Code Fonts: monaco (Monaco / Menlo / Consolas), lucida (Lucida / Source Code Pro)')
  })
})
