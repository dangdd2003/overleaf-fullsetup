import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { configureCompilerSettingsTool } from '../../../../frontend/js/features/ai-assist/agent/tools/configure-compiler-settings'
import { createFakeHandle } from './helpers/fake-handle'

describe('configure_compiler_settings tool', function () {
  it('registers configure_compiler_settings in toolSpecs', function () {
    const names = toolSpecs().map(s => s.name)
    expect(names).to.include('configure_compiler_settings')
  })

  it('is marked mutating and non-suspending', function () {
    expect(configureCompilerSettingsTool.mutates).to.be.true
    expect(configureCompilerSettingsTool.suspends).to.be.false
  })

  it('updates compiler settings: compiler, imageName, rootDocPath, draft, stopOnFirstError', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_compiler_settings.execute(
      {
        compiler: 'lualatex',
        imageName: 'texlive-2024.1',
        rootDocPath: 'chapters/main.tex',
        draft: true,
        stopOnFirstError: true,
      },
      handle
    )

    expect(res.status).to.equal('applied')
    expect(res.updatedSettings.compiler).to.equal('lualatex')
    expect(res.updatedSettings.imageName).to.equal('texlive-2024.1')
    expect(res.updatedSettings.rootDocPath).to.equal('chapters/main.tex')
    expect(res.updatedSettings.draft).to.be.true
    expect(res.updatedSettings.stopOnFirstError).to.be.true

    const configCalls = calls.filter(c => c.name === 'configureCompilerSettings')
    expect(configCalls).to.have.lengthOf(1)
    expect(configCalls[0].args).to.deep.include({
      compiler: 'lualatex',
      imageName: 'texlive-2024.1',
      rootDocPath: 'chapters/main.tex',
      draft: true,
      stopOnFirstError: true,
    })

    const updated = await handle.getProjectSettings()
    expect(updated.compiler.compiler).to.equal('lualatex')
    expect(updated.compiler.imageName).to.equal('texlive-2024.1')
    expect(updated.compiler.rootDocPath).to.equal('chapters/main.tex')
    expect(updated.compiler.draft).to.be.true
    expect(updated.compiler.stopOnFirstError).to.be.true

    const rendered = configureCompilerSettingsTool.render?.(res)
    expect(rendered).to.include('Updated compiler settings')
    expect(rendered).to.include('compiler')
  })

  it('refuses empty settings arguments', async function () {
    const { handle, calls } = createFakeHandle()

    const res: any = await TOOLS.configure_compiler_settings.execute({}, handle)
    expect(res.error).to.include('Supply at least one compiler setting to configure')
    expect(calls.filter(c => c.name === 'configureCompilerSettings')).to.be.empty
  })
})
