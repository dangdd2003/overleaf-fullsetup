import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { configureAppearanceSettingsTool } from '../../../../frontend/js/features/ai-assist/agent/tools/configure-appearance-settings'
import { createFakeHandle } from './helpers/fake-handle'

describe('configure_appearance_settings tool', function () {
  it('registers configure_appearance_settings in toolSpecs', function () {
    const names = toolSpecs().map(s => s.name)
    expect(names).to.include('configure_appearance_settings')
  })

  it('is marked mutating and non-suspending', function () {
    expect(configureAppearanceSettingsTool.mutates).to.be.true
    expect(configureAppearanceSettingsTool.suspends).to.be.false
  })

  it('updates appearance preferences: overallTheme, editorTheme, darkModePdf, fontSize, fontFamily, lineHeight', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_appearance_settings.execute(
      {
        overallTheme: 'dark',
        editorTheme: 'monokai',
        editorLightTheme: 'textmate',
        editorDarkTheme: 'monokai',
        darkModePdf: true,
        fontSize: 16,
        fontFamily: 'consolas',
        lineHeight: 'spacious',
      },
      handle
    )

    expect(res.status).to.equal('applied')
    expect(res.updatedSettings.overallTheme).to.equal('dark')
    expect(res.updatedSettings.editorTheme).to.equal('monokai')
    expect(res.updatedSettings.darkModePdf).to.be.true
    expect(res.updatedSettings.fontSize).to.equal(16)
    expect(res.updatedSettings.fontFamily).to.equal('consolas')
    expect(res.updatedSettings.lineHeight).to.equal('spacious')

    const configCalls = calls.filter(c => c.name === 'configureAppearanceSettings')
    expect(configCalls).to.have.lengthOf(1)
    expect(configCalls[0].args).to.deep.include({
      overallTheme: 'dark',
      editorTheme: 'monokai',
      darkModePdf: true,
      fontSize: 16,
      fontFamily: 'consolas',
      lineHeight: 'spacious',
    })

    const updated = await handle.getProjectSettings()
    expect(updated.appearance.overallTheme).to.equal('dark')
    expect(updated.appearance.editorTheme).to.equal('monokai')
    expect(updated.appearance.darkModePdf).to.be.true
    expect(updated.appearance.fontSize).to.equal(16)
    expect(updated.appearance.fontFamily).to.equal('consolas')
    expect(updated.appearance.lineHeight).to.equal('spacious')

    const rendered = configureAppearanceSettingsTool.render?.(res)
    expect(rendered).to.include('Updated appearance settings')
    expect(rendered).to.include('overallTheme')
  })

  it('refuses empty settings arguments', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_appearance_settings.execute({}, handle)
    expect(res.error).to.include('Supply at least one appearance setting to configure')
    expect(calls.filter(c => c.name === 'configureAppearanceSettings')).to.be.empty
  })
})
