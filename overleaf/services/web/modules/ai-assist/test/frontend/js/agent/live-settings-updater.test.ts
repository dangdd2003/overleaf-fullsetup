import { expect } from 'chai'
import sinon from 'sinon'
import {
  applyLiveSettingsUpdate,
  normalizeOverallTheme,
} from '../../../../frontend/js/features/ai-assist/agent/live-settings-updater'

describe('live-settings-updater', function () {
  it('normalizes overallTheme correctly', function () {
    expect(normalizeOverallTheme('dark')).to.equal('')
    expect(normalizeOverallTheme('default')).to.equal('')
    expect(normalizeOverallTheme('DARK')).to.equal('')
    expect(normalizeOverallTheme('light')).to.equal('light-')
    expect(normalizeOverallTheme('light-')).to.equal('light-')
    expect(normalizeOverallTheme('system')).to.equal('system')
  })

  it('updates document.body.dataset.theme and userSettingsContext on appearance update', function () {
    const setUserSettings = sinon.stub()
    const userSettingsContext = { setUserSettings }

    applyLiveSettingsUpdate(
      'configure_appearance_settings',
      {
        overallTheme: 'dark',
        fontSize: 14,
        editorTheme: 'monokai',
        fontFamily: 'lucida',
      },
      { userSettingsContext, projectId: 'p1' }
    )

    expect(document.body.dataset.theme).to.equal('default')
    expect(setUserSettings.calledOnce).to.be.true

    const updater = setUserSettings.firstCall.args[0]
    const state = updater({ existing: true })
    expect(state.overallTheme).to.equal('')
    expect(state.fontSize).to.equal(14)
    expect(state.editorTheme).to.equal('monokai')
    expect(state.fontFamily).to.equal('lucida')
  })

  it('updates document.body.dataset.theme to light on light theme selection', function () {
    const setUserSettings = sinon.stub()
    applyLiveSettingsUpdate(
      'configure_appearance_settings',
      { overallTheme: 'light' },
      { userSettingsContext: { setUserSettings }, projectId: 'p1' }
    )

    expect(document.body.dataset.theme).to.equal('light')
  })

  it('updates projectContext on compiler settings update', function () {
    const updateProject = sinon.stub()
    const projectContext = { updateProject }

    applyLiveSettingsUpdate(
      'configure_compiler_settings',
      {
        compiler: 'xelatex',
        imageName: 'texlive-2024.1',
      },
      { projectContext, projectId: 'p1' }
    )

    expect(updateProject.calledOnce).to.be.true
    expect(updateProject.firstCall.args[0]).to.deep.equal({
      compiler: 'xelatex',
      imageName: 'texlive-2024.1',
    })
  })

  it('detects appearance settings by property even without matching toolName', function () {
    const setUserSettings = sinon.stub()
    applyLiveSettingsUpdate(
      '',
      { fontSize: 18, editorTheme: 'chrome' },
      { userSettingsContext: { setUserSettings }, projectId: 'p1' }
    )

    expect(setUserSettings.calledOnce).to.be.true
    const state = setUserSettings.firstCall.args[0]({})
    expect(state.fontSize).to.equal(18)
    expect(state.editorTheme).to.equal('chrome')
  })

  it('detects compiler settings by property and dispatches storage events', function () {
    const updateProject = sinon.stub()
    const projectContext = { updateProject }
    const storageSpy = sinon.spy()
    window.addEventListener('storage', storageSpy)

    applyLiveSettingsUpdate(
      '',
      { compiler: 'lualatex', draft: true, stopOnFirstError: true },
      { projectContext, projectId: 'proj-123' }
    )

    window.removeEventListener('storage', storageSpy)

    expect(updateProject.calledOnce).to.be.true
    expect(updateProject.firstCall.args[0]).to.deep.equal({ compiler: 'lualatex' })
    expect(storageSpy.calledTwice).to.be.true
  })

  it('detects editor settings and updates userSettingsContext and projectContext for spellCheck', function () {
    const setUserSettings = sinon.stub()
    const updateProject = sinon.stub()

    applyLiveSettingsUpdate(
      'configure_editor_settings',
      {
        mode: 'vim',
        autoComplete: true,
        spellCheckLanguage: 'fr',
      },
      {
        userSettingsContext: { setUserSettings },
        projectContext: { updateProject },
        projectId: 'p1',
      }
    )

    expect(setUserSettings.calledOnce).to.be.true
    const state = setUserSettings.firstCall.args[0]({})
    expect(state.mode).to.equal('vim')
    expect(state.autoComplete).to.be.true
    expect(state.spellCheckLanguage).to.equal('fr')
    expect(updateProject.calledWith({ spellCheckLanguage: 'fr' })).to.be.true
  })

  it('detects editor settings by property even without matching toolName', function () {
    const setUserSettings = sinon.stub()

    applyLiveSettingsUpdate(
      '',
      {
        syntaxValidation: false,
        pdfViewer: 'pdfjs',
      },
      {
        userSettingsContext: { setUserSettings },
        projectId: 'p1',
      }
    )

    expect(setUserSettings.calledOnce).to.be.true
    const state = setUserSettings.firstCall.args[0]({})
    expect(state.syntaxValidation).to.be.false
    expect(state.pdfViewer).to.equal('pdfjs')
  })

  it('dispatches aiAssist:settingsUpdated custom event on window', function (done) {
    const onSettings = (event: Event) => {
      window.removeEventListener('aiAssist:settingsUpdated', onSettings)
      const detail = (event as CustomEvent).detail
      expect(detail.toolName).to.equal('configure_appearance_settings')
      expect(detail.settings.fontSize).to.equal(16)
      done()
    }

    window.addEventListener('aiAssist:settingsUpdated', onSettings)
    applyLiveSettingsUpdate(
      'configure_appearance_settings',
      { fontSize: 16 },
      { projectId: 'p1' }
    )
  })

  it('safely handles exceptions thrown from context setters', function () {
    const throwingSetUserSettings = sinon.stub().throws(new Error('setter failed'))
    const throwingUpdateProject = sinon.stub().throws(new Error('update project failed'))

    expect(() => {
      applyLiveSettingsUpdate(
        'configure_editor_settings',
        { mode: 'vim', spellCheckLanguage: 'fr' },
        {
          userSettingsContext: { setUserSettings: throwingSetUserSettings },
          projectContext: { updateProject: throwingUpdateProject, project: { spellCheckLanguage: 'en' } },
          projectId: 'p1',
        }
      )
    }).to.not.throw()
  })
})
