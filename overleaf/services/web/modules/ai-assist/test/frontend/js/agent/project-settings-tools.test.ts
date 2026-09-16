import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { getProjectSettingsTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-project-settings'
import { createFakeHandle } from './helpers/fake-handle'

describe('get_project_settings tool', function () {
  it('registers get_project_settings in toolSpecs', function () {
    const names = toolSpecs().map(s => s.name)
    expect(names).to.include('get_project_settings')
  })

  it('is marked non-mutating and non-suspending', function () {
    expect(getProjectSettingsTool.mutates).to.be.false
    expect(getProjectSettingsTool.suspends).to.be.false
  })

  it('returns project settings summary', async function () {
    const { handle } = createFakeHandle({
      compilerSettings: {
        compiler: 'xelatex',
        imageName: 'texlive-2024.1',
        rootDocPath: 'main.tex',
        rootDocId: 'doc-1',
        draft: false,
        stopOnFirstError: false,
      },
      appearanceSettings: {
        overallTheme: 'dark',
        editorTheme: 'monokai',
        editorLightTheme: 'textmate',
        editorDarkTheme: 'monokai',
        darkModePdf: true,
        fontSize: 14,
        fontFamily: 'consolas',
        lineHeight: 'normal',
      },
      editorSettings: {
        mode: 'vim',
        autoComplete: true,
        autoPairDelimiters: true,
        syntaxValidation: true,
        pdfViewer: 'native',
        mathPreview: true,
        breadcrumbs: true,
        editorTabs: true,
        spellCheckLanguage: 'en_GB',
      },
      projectSettingsSummary: {
        compiler: {
          compiler: 'xelatex',
          imageName: 'texlive-2024.1',
          rootDocPath: 'main.tex',
        },
        appearance: {
          overallTheme: 'dark',
          editorTheme: 'monokai',
          fontSize: 14,
        },
        editor: {
          mode: 'vim',
          pdfViewer: 'native',
        },
        spelling: {
          spellCheckLanguage: 'en_GB',
        },
        name: 'Research Paper',
        description: 'NLP evaluation',
      },
    })

    const res: any = await TOOLS.get_project_settings.execute({}, handle)
    expect(res.status).to.equal('ok')
    expect(res.settings.compiler.compiler).to.equal('xelatex')
    expect(res.settings.compiler.imageName).to.equal('texlive-2024.1')
    expect(res.settings.compiler.rootDocPath).to.equal('main.tex')
    expect(res.settings.appearance.overallTheme).to.equal('dark')
    expect(res.settings.editor.mode).to.equal('vim')
    expect(res.settings.spelling.spellCheckLanguage).to.equal('en_GB')
    expect(res.settings.name).to.equal('Research Paper')

    const rendered = getProjectSettingsTool.render?.(res)
    expect(rendered).to.include('Compiler: xelatex')
    expect(rendered).to.include('TeX Live: texlive-2024.1')
    expect(rendered).to.include('Root Document: main.tex')
    expect(rendered).to.include('Project Name: Research Paper')
    expect(rendered).to.include('Keybindings: vim')
  })
})
