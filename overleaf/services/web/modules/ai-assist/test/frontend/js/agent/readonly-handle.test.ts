import { expect } from 'chai'
import sinon from 'sinon'
import { readOnlyHandle } from '../../../../frontend/js/features/ai-assist/agent/readonly-handle'

function fakeHandle() {
  return {
    listFiles: sinon.stub().resolves([]),
    readFile: sinon.stub().resolves({ lines: [] }),
    proposeEdit: sinon.stub().resolves({ status: 'applied' }),
    createFile: sinon.stub().resolves({ status: 'applied' }),
    configureAppearanceSettings: sinon.stub().resolves({ status: 'applied' }),
    configureCompilerSettings: sinon.stub().resolves({ status: 'applied' }),
    configureEditorSettings: sinon.stub().resolves({ status: 'applied' }),
    getProjectSettings: sinon.stub().resolves({ compiler: { compiler: 'pdflatex' } }),
    listAvailableSettings: sinon.stub().resolves({ compilers: ['pdflatex'] }),
    rootDocPath: () => 'main.tex',
  } as any
}

describe('readOnlyHandle', function () {
  it('refuses proposeEdit', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).proposeEdit({
        path: 'a.tex',
        oldText: 'x',
        newText: 'y',
      })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.proposeEdit.called).to.equal(false)
  })

  it('refuses createFile', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).createFile({ path: 'a.tex', content: 'hi' })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.createFile.called).to.equal(false)
  })

  it('refuses configureAppearanceSettings', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).configureAppearanceSettings({ overallTheme: 'dark' })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.configureAppearanceSettings.called).to.equal(false)
  })

  it('refuses configureCompilerSettings', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).configureCompilerSettings({ compiler: 'xelatex' })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.configureCompilerSettings.called).to.equal(false)
  })

  it('refuses configureEditorSettings', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).configureEditorSettings({ mode: 'vim' })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.configureEditorSettings.called).to.equal(false)
  })

  it('passes reads straight through', async function () {
    const inner = fakeHandle()
    await readOnlyHandle(inner).listFiles()
    expect(inner.listFiles.calledOnce).to.equal(true)

    const proj = await readOnlyHandle(inner).getProjectSettings()
    expect(proj.compiler.compiler).to.equal('pdflatex')
    expect(inner.getProjectSettings.calledOnce).to.equal(true)

    const avail = await readOnlyHandle(inner).listAvailableSettings()
    expect(avail.compilers).to.deep.equal(['pdflatex'])
    expect(inner.listAvailableSettings.calledOnce).to.equal(true)
  })
})
