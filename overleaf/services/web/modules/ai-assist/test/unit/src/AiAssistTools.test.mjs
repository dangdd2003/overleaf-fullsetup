import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'

describe('AiAssistTools', function () {
  let tools
  let mockDocUpdater
  let mockEntityHandler
  let mockEditorController
  let mockCompileManager
  let mockProjectGetter
  let mockProjectOptionsHandler
  let mockUserModel
  let mockSettings

  beforeEach(function () {
    mockDocUpdater = {
      getDocument: sinon.stub().callsFake(async (pid, docId) => {
        if (docId === 'doc-1') {
          return { lines: ['line 1', 'line 2: target text', 'line 3'] }
        }
        return { lines: ['other file', 'no match here'] }
      }),
      setDocument: sinon.stub().resolves({ rev: 1, modified: true }),
    }

    mockEntityHandler = {
      getAllDocs: sinon.stub().resolves([
        { _id: 'doc-1', name: 'main.tex', path: 'main.tex' },
        { _id: 'doc-2', name: 'chapters/intro.tex', path: 'chapters/intro.tex' },
        { _id: 'doc-bib', name: 'references.bib', path: 'references.bib' },
      ]),
      getDocPathByProjectIdAndDocId: sinon.stub().callsFake(async (pid, docId) => {
        if (docId === 'doc-1') return 'main.tex'
        if (docId === 'doc-bib') return 'references.bib'
        return 'chapters/intro.tex'
      }),
      getDocIdByPath: sinon.stub().callsFake(async (pid, path) => {
        if (path === 'main.tex') return 'doc-1'
        if (path === 'references.bib') return 'doc-bib'
        return null
      }),
    }

    mockEditorController = {
      addDoc: sinon.stub().yields(null, { _id: 'doc-new' }, 'root-folder'),
      promises: {
        renameProject: sinon.stub().resolves(),
        updateProjectDescription: sinon.stub().resolves(),
        setRootDoc: sinon.stub().resolves(),
        setMainBibliographyDoc: sinon.stub().resolves(),
      },
    }

    mockCompileManager = {
      compile: sinon.stub().resolves({ status: 'success', outputFiles: [] }),
    }

    mockProjectGetter = {
      getProject: sinon.stub().resolves({
        _id: 'p1',
        name: 'My Paper',
        description: 'A study on AI integration',
        compiler: 'xelatex',
        imageName: 'texlive-2024.1',
        rootDoc_id: 'doc-1',
        mainBibliographyDoc_id: 'doc-bib',
        spellCheckLanguage: 'en_GB',
        owner_ref: '012345678901234567890123',
        rootFolder: [{ _id: 'root-folder' }],
        draft: false,
        stopOnFirstError: false,
      }),
    }

    mockProjectOptionsHandler = {
      setCompiler: sinon.stub().resolves(),
      setImageName: sinon.stub().resolves(),
      setSpellCheckLanguage: sinon.stub().resolves(),
      setDraft: sinon.stub().resolves(),
      setStopOnFirstError: sinon.stub().resolves(),
    }

    mockUserModel = {
      findById: sinon.stub(),
    }

    mockSettings = {
      safeCompilers: ['pdflatex', 'latex', 'xelatex', 'lualatex'],
      allowedImageNames: [{ imageName: 'texlive-2024.1', imageDesc: 'TeX Live 2024', default: true }],
      languages: [
        { code: 'en', name: 'English' },
        { code: 'fr', name: 'French' },
      ],
    }

    tools = new AiAssistTools({
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      projectGetter: mockProjectGetter,
      editorController: mockEditorController,
      compileManager: mockCompileManager,
      projectOptionsHandler: mockProjectOptionsHandler,
      userModel: mockUserModel,
      settings: mockSettings,
    })
  })

  it('reads lines from a document via read_file', async function () {
    const res = await tools.execute('read_file', { path: 'main.tex', from: 1, to: 2 }, {
      projectId: 'p1',
      userId: '012345678901234567890123',
    })

    expect(res.content).to.equal('line 1\nline 2: target text')
    expect(res.from).to.equal(1)
    expect(res.to).to.equal(2)
  })

  it('performs text replacement via edit_file', async function () {
    const validUserId = '012345678901234567890123'
    const res = await tools.execute(
      'edit_file',
      { path: 'main.tex', oldText: 'target text', newText: 'updated text' },
      { projectId: 'p1', userId: validUserId }
    )

    expect(res.status).to.equal('applied')
    expect(mockDocUpdater.setDocument.calledOnce).to.be.true
    const updatedLines = mockDocUpdater.setDocument.firstCall.args[3]
    expect(updatedLines[1]).to.equal('line 2: updated text')
  })

  it('creates new files via create_file', async function () {
    const res = await tools.execute(
      'create_file',
      { path: 'references.bib', content: '@article{test}' },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(mockEditorController.addDoc.calledOnce).to.be.true
  })

  it('searches across project documents via search_text and search_project alias', async function () {
    const validUserId = '012345678901234567890123'
    const resText = await tools.execute(
      'search_text',
      { query: 'target' },
      { projectId: 'p1', userId: validUserId }
    )
    expect(resText.hits).to.have.lengthOf(1)
    expect(resText.hits[0].path).to.equal('main.tex')
    expect(resText.hits[0].line).to.equal(2)

    const resProj = await tools.execute(
      'search_project',
      { query: 'target' },
      { projectId: 'p1', userId: validUserId }
    )
    expect(resProj.hits).to.have.lengthOf(1)
    expect(resProj.hits[0].path).to.equal('main.tex')
    expect(resProj.hits[0].line).to.equal(2)
  })

  it('handles getAllDocs returning an object dictionary (Overleaf real production format)', async function () {
    mockDocUpdater.getDocument = sinon.stub().callsFake(async (pid, docId) => {
      if (docId === 'doc-bib') return { lines: ['@article{sample}'] }
      return { lines: ['line 1', 'line 2: target text', 'line 3'] }
    })
    mockEntityHandler.getAllDocs = sinon.stub().resolves({
      'main.tex': { _id: 'doc-1', name: 'main.tex', lines: ['line 1', 'line 2: target text', 'line 3'] },
      'ref.bib': { _id: 'doc-bib', name: 'ref.bib', lines: ['@article{sample}'] },
    })

    const validUserId = '012345678901234567890123'
    const readRes = await tools.execute('read_file', { path: 'ref.bib' }, {
      projectId: 'p1',
      userId: validUserId,
    })
    expect(readRes.content).to.equal('@article{sample}')
    expect(readRes.totalLines).to.equal(1)

    const listRes = await tools.execute('list_files', {}, {
      projectId: 'p1',
      userId: validUserId,
    })
    expect(listRes.files).to.have.lengthOf(2)
    expect(listRes.files.map(f => f.path)).to.include('ref.bib')

    const searchRes = await tools.execute('search_project', { query: 'sample' }, {
      projectId: 'p1',
      userId: validUserId,
    })
    expect(searchRes.hits).to.have.lengthOf(1)
    expect(searchRes.hits[0].path).to.equal('ref.bib')
  })

  it('compiles project and parses output.log from clsi into errors and warnings', async function () {
    const fakeLog = [
      'This is pdfTeX',
      'LaTeX Warning: Reference `sec:intro` on page 1 undefined on input line 42.',
      '! Undefined control sequence.',
      'l.50 \\foobar',
    ].join('\n')

    mockCompileManager.compile.resolves({
      status: 'failure',
      outputFiles: [{ path: 'output.log' }, { path: 'output.pdf' }],
      clsiServerId: 'clsi-1',
      buildId: 'build-123',
    })

    const mockClsiManager = {
      getOutputFileStream: sinon.stub().callsFake(async () => {
        return (async function* () {
          yield Buffer.from(fakeLog)
        })()
      }),
    }

    tools = new AiAssistTools({
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      projectGetter: mockProjectGetter,
      editorController: mockEditorController,
      compileManager: mockCompileManager,
      clsiManager: mockClsiManager,
    })

    const validUserId = '012345678901234567890123'
    const res = await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })
    expect(res.status).to.equal('failure')
    expect(res.errorCount).to.equal(1)
    expect(res.warningCount).to.equal(1)
    expect(res.errors[0].message).to.equal('Undefined control sequence.')
    expect(res.errors[0].line).to.equal(50)
    expect(res.warnings[0].message).to.include('Reference `sec:intro` on page 1 undefined')

    const logRes = await tools.execute('get_compile_result', { severity: 'warnings' }, { projectId: 'p1', userId: validUserId })
    expect(logRes.warningCount).to.equal(1)
    expect(logRes.warnings).to.have.lengthOf(1)
    expect(logRes.warnings[0].message).to.include('Reference `sec:intro`')
  })

  it('reads project settings summary via get_project_settings', async function () {
    mockUserModel.findById.returns({
      select: sinon.stub().returns({
        exec: sinon.stub().resolves({
          _id: '012345678901234567890123',
          ace: {
            mode: 'vim',
            overallTheme: 'dark',
            fontSize: 14,
            autoComplete: true,
          },
        }),
      }),
    })

    const res = await tools.execute('get_project_settings', {}, {
      projectId: 'p1',
      userId: '012345678901234567890123',
    })

    expect(res.status).to.equal('ok')
    expect(res.settings.compiler.compiler).to.equal('xelatex')
    expect(res.settings.compiler.imageName).to.equal('texlive-2024.1')
    expect(res.settings.compiler.rootDocPath).to.equal('main.tex')
    expect(res.settings.appearance.overallTheme).to.equal('dark')
    expect(res.settings.appearance.fontSize).to.equal(14)
    expect(res.settings.editor.mode).to.equal('vim')
    expect(res.settings.editor.autoComplete).to.be.true
    expect(res.settings.spelling.spellCheckLanguage).to.equal('en_GB')
    expect(res.settings.name).to.equal('My Paper')
  })

  it('updates compiler settings via configure_compiler_settings', async function () {
    const res = await tools.execute(
      'configure_compiler_settings',
      {
        compiler: 'lualatex',
        imageName: 'texlive-2024.1',
        rootDocPath: 'main.tex',
        draft: true,
        stopOnFirstError: true,
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(mockProjectOptionsHandler.setCompiler.calledWith('p1', 'lualatex')).to.be.true
    expect(mockProjectOptionsHandler.setImageName.calledWith('p1', 'texlive-2024.1')).to.be.true
    expect(mockProjectOptionsHandler.setDraft.calledWith('p1', true)).to.be.true
    expect(mockProjectOptionsHandler.setStopOnFirstError.calledWith('p1', true)).to.be.true
    expect(mockEditorController.promises.setRootDoc.calledWith('p1', 'doc-1')).to.be.true
  })

  it('configures appearance preferences via configure_appearance_settings', async function () {
    const saveStub = sinon.stub().resolves()
    const fakeUser = {
      _id: '012345678901234567890123',
      ace: { overallTheme: 'system', fontSize: 12 },
      save: saveStub,
    }
    mockUserModel.findById.returns({
      exec: sinon.stub().resolves(fakeUser),
    })

    const res = await tools.execute(
      'configure_appearance_settings',
      {
        overallTheme: 'dark',
        editorTheme: 'monokai',
        darkModePdf: true,
        fontSize: 16,
        fontFamily: 'consolas',
        lineHeight: 'spacious',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(fakeUser.ace.overallTheme).to.equal('')
    expect(fakeUser.ace.theme).to.equal('monokai')
    expect(fakeUser.ace.darkModePdf).to.be.true
    expect(fakeUser.ace.fontSize).to.equal(16)
    expect(fakeUser.ace.fontFamily).to.equal('consolas')
    expect(fakeUser.ace.lineHeight).to.equal('spacious')
    expect(res.updatedSettings.overallTheme).to.equal('')
    expect(res.updatedSettings.editorTheme).to.equal('monokai')
    expect(res.updatedSettings.darkModePdf).to.be.true
    expect(res.updatedSettings.fontSize).to.equal(16)
    expect(res.updatedSettings.fontFamily).to.equal('consolas')
    expect(res.updatedSettings.lineHeight).to.equal('spacious')
    expect(saveStub.calledOnce).to.be.true
  })

  it('configures editor preferences via configure_editor_settings', async function () {
    const saveStub = sinon.stub().resolves()
    const fakeUser = {
      _id: '012345678901234567890123',
      ace: { mode: 'none', fontSize: 12 },
      save: saveStub,
    }
    mockUserModel.findById.returns({
      exec: sinon.stub().resolves(fakeUser),
    })

    const res = await tools.execute(
      'configure_editor_settings',
      {
        mode: 'vim',
        autoComplete: false,
        autoPairDelimiters: false,
        syntaxValidation: true,
        pdfViewer: 'native',
        spellCheckLanguage: 'en_GB',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )

    expect(res.status).to.equal('applied')
    expect(fakeUser.ace.mode).to.equal('vim')
    expect(fakeUser.ace.autoComplete).to.be.false
    expect(fakeUser.ace.autoPairDelimiters).to.be.false
    expect(fakeUser.ace.syntaxValidation).to.be.true
    expect(fakeUser.ace.pdfViewer).to.equal('native')
    expect(fakeUser.ace.spellCheckLanguage).to.equal('en_GB')
    expect(res.updatedSettings.mode).to.equal('vim')
    expect(res.updatedSettings.autoComplete).to.be.false
    expect(res.updatedSettings.autoPairDelimiters).to.be.false
    expect(res.updatedSettings.syntaxValidation).to.be.true
    expect(res.updatedSettings.pdfViewer).to.equal('native')
    expect(res.updatedSettings.spellCheckLanguage).to.equal('en_GB')
    expect(saveStub.calledOnce).to.be.true
  })

  it('rejects attempt to modify account settings via configure_editor_settings and configure_appearance_settings', async function () {
    const resEd = await tools.execute(
      'configure_editor_settings',
      {
        email: 'hacked@evil.com',
        password: 'password123',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(resEd.error).to.include('Cannot modify account settings')

    const resApp = await tools.execute(
      'configure_appearance_settings',
      {
        billing: 'premium',
      },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(resApp.error).to.include('Cannot modify account settings')
    expect(mockUserModel.findById.called).to.be.false
  })

  it('lists allowed options via list_available_settings', async function () {
    const res = await tools.execute('list_available_settings', {}, {
      projectId: 'p1',
      userId: '012345678901234567890123',
    })

    expect(res.status).to.equal('ok')
    expect(res.options.compilers).to.include('pdflatex')
    expect(res.options.compilers).to.include('xelatex')
    expect(res.options.editorModes).to.include('vim')
    expect(res.options.overallThemes).to.include('dark')
    expect(res.options.editorThemes).to.include('monokai')
    expect(res.options.editorThemes).to.include('dracula')
    expect(res.options.editorThemes).to.include('tomorrow_night_eighties')
    expect(res.options.fontFamilies).to.deep.include({ name: 'monaco', label: 'Monaco / Menlo / Consolas' })
    expect(res.options.spellCheckLanguages[0].code).to.equal('en')
  })

  it('executes get_outline, get_packages, and get_references tools', async function () {
    const validUserId = '012345678901234567890123'
    const outlineRes = await tools.execute('get_outline', {}, { projectId: 'p1', userId: validUserId })
    expect(outlineRes).to.have.property('rootDoc', 'main.tex')
    expect(outlineRes).to.have.property('sections')

    const pkgRes = await tools.execute('get_packages', {}, { projectId: 'p1', userId: validUserId })
    expect(pkgRes).to.have.property('packages')

    const refRes = await tools.execute('get_references', { kind: 'all' }, { projectId: 'p1', userId: validUserId })
    expect(refRes).to.have.property('references')
  })

  it('returns all 15 tool specifications in getToolSpecs', function () {
    const specs = tools.getToolSpecs()
    const names = specs.map(s => s.name)
    const expected = [
      'get_outline',
      'get_packages',
      'get_references',
      'list_files',
      'read_file',
      'search_text',
      'edit_file',
      'create_file',
      'compile_project',
      'get_compile_result',
      'get_project_settings',
      'configure_appearance_settings',
      'configure_compiler_settings',
      'configure_editor_settings',
      'list_available_settings',
    ]

    expect(names).to.deep.equal(expected)
    expect(specs).to.have.lengthOf(15)

    // Verify parameter schemas for settings specs
    const compSpec = specs.find(s => s.name === 'configure_compiler_settings')
    expect(compSpec.parameters.properties).to.have.all.keys(
      'compiler',
      'imageName',
      'rootDocPath',
      'draft',
      'stopOnFirstError'
    )

    const appSpec = specs.find(s => s.name === 'configure_appearance_settings')
    expect(appSpec.parameters.properties).to.have.all.keys(
      'overallTheme',
      'editorTheme',
      'editorLightTheme',
      'editorDarkTheme',
      'darkModePdf',
      'fontSize',
      'fontFamily',
      'lineHeight'
    )

    const edSpec = specs.find(s => s.name === 'configure_editor_settings')
    expect(edSpec.parameters.properties).to.have.all.keys(
      'mode',
      'autoComplete',
      'autoPairDelimiters',
      'syntaxValidation',
      'pdfViewer',
      'mathPreview',
      'breadcrumbs',
      'editorTabs',
      'spellCheckLanguage'
    )
  })

  it('rejects execution when userId is missing or invalid without falling back to owner_ref', async function () {
    const customTools = new AiAssistTools({
      projectGetter: {
        getProject: sinon.stub().resolves({ owner_ref: '507f1f77bcf86cd799439011' }),
      },
    })

    const result = await customTools.execute('edit_file', { path: 'main.tex', oldText: 'a', newText: 'b' }, {
      projectId: '507f1f77bcf86cd799439012',
      userId: null,
    })

    expect(result.error).to.include('user')
    expect(customTools.projectGetter.getProject.called).to.be.false
  })

  it('rejects path traversal attempts in read_file and edit_file', async function () {
    const customTools = new AiAssistTools()
    const badPaths = ['../../etc/passwd', '../secret.tex', '/../root.tex']

    for (const path of badPaths) {
      const readResult = await customTools.execute('read_file', { path }, {
        projectId: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439011',
      })
      expect(readResult.error, `read_file should reject ${path}`).to.include('traversal')

      const editResult = await customTools.execute('edit_file', { path, oldText: 'x', newText: 'y' }, {
        projectId: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439011',
      })
      expect(editResult.error, `edit_file should reject ${path}`).to.include('traversal')
    }
  })
})
