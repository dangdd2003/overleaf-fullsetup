import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { configureEditorSettingsTool } from '../../../../frontend/js/features/ai-assist/agent/tools/configure-editor-settings'
import { createFakeHandle } from './helpers/fake-handle'

describe('configure_editor_settings tool', function () {
  it('registers configure_editor_settings in toolSpecs', function () {
    const names = toolSpecs().map(s => s.name)
    expect(names).to.include('configure_editor_settings')
  })

  it('is marked mutating and non-suspending', function () {
    expect(configureEditorSettingsTool.mutates).to.be.true
    expect(configureEditorSettingsTool.suspends).to.be.false
  })

  it('updates editor settings: mode, autoComplete, autoPairDelimiters, syntaxValidation, pdfViewer, spellCheckLanguage', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_editor_settings.execute(
      {
        mode: 'vim',
        autoComplete: false,
        autoPairDelimiters: false,
        syntaxValidation: true,
        pdfViewer: 'native',
        spellCheckLanguage: 'en_GB',
      },
      handle
    )

    expect(res.status).to.equal('applied')
    expect(res.updatedSettings.mode).to.equal('vim')
    expect(res.updatedSettings.autoComplete).to.be.false
    expect(res.updatedSettings.autoPairDelimiters).to.be.false
    expect(res.updatedSettings.syntaxValidation).to.be.true
    expect(res.updatedSettings.pdfViewer).to.equal('native')
    expect(res.updatedSettings.spellCheckLanguage).to.equal('en_GB')

    const configCalls = calls.filter(c => c.name === 'configureEditorSettings')
    expect(configCalls).to.have.lengthOf(1)
    expect(configCalls[0].args).to.deep.include({
      mode: 'vim',
      autoComplete: false,
      autoPairDelimiters: false,
      syntaxValidation: true,
      pdfViewer: 'native',
      spellCheckLanguage: 'en_GB',
    })

    const updated = await handle.getProjectSettings()
    expect(updated.editor.mode).to.equal('vim')
    expect(updated.editor.autoComplete).to.be.false
    expect(updated.editor.autoPairDelimiters).to.be.false
    expect(updated.editor.syntaxValidation).to.be.true
    expect(updated.editor.pdfViewer).to.equal('native')

    const rendered = configureEditorSettingsTool.render?.(res)
    expect(rendered).to.include('Updated editor settings')
    expect(rendered).to.include('mode')
  })

  it('refuses empty settings arguments', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_editor_settings.execute({}, handle)
    expect(res.error).to.include('Supply at least one editor setting to configure')
    expect(calls.filter(c => c.name === 'configureEditorSettings')).to.be.empty
  })
})
