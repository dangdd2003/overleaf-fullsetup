import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Settings from '@overleaf/settings'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

const ProjectGetter = {
  promises: { findAllUsersProjects: vi.fn(), getProject: vi.fn() },
}
const ProjectCreationHandler = {
  promises: {
    createBasicProject: vi.fn(),
    createExampleProject: vi.fn(),
    createBlankProject: vi.fn(),
  },
}
const ProjectDuplicator = { promises: { duplicate: vi.fn() } }
const ProjectDeleter = {
  promises: {
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    trashProject: vi.fn(),
    untrashProject: vi.fn(),
    deleteProject: vi.fn(),
  },
}
const ProjectDetailsHandler = {
  promises: { validateProjectName: vi.fn(), generateUniqueName: vi.fn() },
}
const ProjectEntityHandler = { promises: { getAllEntities: vi.fn() } }
const ProjectAuditLogHandler = { addEntryIfManagedInBackground: vi.fn() }
const EditorController = {
  promises: {
    upsertDocWithPath: vi.fn(),
    renameProject: vi.fn(),
    setCompiler: vi.fn(),
    setImageName: vi.fn(),
    setSpellCheckLanguage: vi.fn(),
    setRootDoc: vi.fn(),
  },
}
const AuthorizationManager = {
  promises: {
    getPrivilegeLevelForProject: vi.fn(),
    canUserWriteProjectSettings: vi.fn(),
    canUserAdminProject: vi.fn(),
    canUserRenameProject: vi.fn(),
  },
}
const UserGetter = { promises: { getUsers: vi.fn() } }

vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: ProjectGetter,
}))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectCreationHandler.mjs',
  () => ({ default: ProjectCreationHandler })
)
vi.mock(
  '../../../../../app/src/Features/Project/ProjectDuplicator.mjs',
  () => ({ default: ProjectDuplicator })
)
vi.mock('../../../../../app/src/Features/Project/ProjectDeleter.mjs', () => ({
  default: ProjectDeleter,
}))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs',
  () => ({ default: ProjectDetailsHandler })
)
vi.mock(
  '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
  () => ({ default: ProjectEntityHandler })
)
vi.mock(
  '../../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs',
  () => ({
    default: {
      isPathValidForRootDoc: docPath => /\.tex$/i.test(docPath),
    },
  })
)
vi.mock(
  '../../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs',
  () => ({ default: ProjectAuditLogHandler })
)
vi.mock('../../../../../app/src/Features/Editor/EditorController.mjs', () => ({
  default: EditorController,
}))
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
  () => ({ default: AuthorizationManager })
)
vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: UserGetter,
}))

const { default: McpProjectsController } = await import(
  '../../../app/src/McpProjectsController.mjs'
)

function res() {
  return {
    statusCode: 200,
    body: null,
    setTimeout() {},
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

/** Entities as ProjectEntityHandler.getAllEntities returns them. */
function tree({ docs = [], files = [] } = {}) {
  return {
    docs: docs.map(([id, path]) => ({ path, doc: { _id: id } })),
    files: files.map(([id, path]) => ({ path, file: { _id: id } })),
  }
}

const ORIGINAL_SETTINGS = {
  allowedImageNames: Settings.allowedImageNames,
  imageRoot: Settings.imageRoot,
}

beforeEach(() => {
  vi.clearAllMocks()
  Settings.allowedImageNames = undefined
  Settings.imageRoot = ''
  UserGetter.promises.getUsers.mockResolvedValue([])
  AuthorizationManager.promises.canUserRenameProject.mockResolvedValue(true)
  AuthorizationManager.promises.canUserAdminProject.mockResolvedValue(true)
  ProjectDetailsHandler.promises.validateProjectName.mockResolvedValue(undefined)
})

afterEach(() => {
  Settings.allowedImageNames = ORIGINAL_SETTINGS.allowedImageNames
  Settings.imageRoot = ORIGINAL_SETTINGS.imageRoot
})

describe('McpProjectsController.listProjects', () => {
  const sample = {
    owned: [
      {
        _id: 'p1',
        name: 'Zeta paper',
        lastUpdated: '2026-03-05T00:00:00.000Z',
        owner_ref: 'u1',
        compiler: 'pdflatex',
        archived: [],
        trashed: [],
      },
    ],
    readAndWrite: [
      {
        _id: 'p2',
        name: 'Alpha draft',
        lastUpdated: '2026-01-01T00:00:00.000Z',
        owner_ref: 'u2',
        archived: [],
        trashed: [],
      },
    ],
    readOnly: [],
    review: [],
    tokenReadAndWrite: [],
    tokenReadOnly: [],
  }

  beforeEach(() => {
    UserGetter.promises.getUsers.mockResolvedValue([
      { _id: 'u2', first_name: 'Ada', last_name: 'Lovelace' },
    ])
  })

  it('returns owned and shared projects, newest first, with access and owner', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const r = res()
    await McpProjectsController.listProjects({ mcpUserId: 'u1', query: {} }, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.body.projects[0]).toMatchObject({
      name: 'Zeta paper',
      accessLevel: 'owner',
      compiler: 'pdflatex',
    })
    expect(r.body.projects[1]).toMatchObject({
      id: 'p2',
      accessLevel: 'readAndWrite',
      owner: { id: 'u2', name: 'Ada Lovelace' },
    })
    expect(r.body).toMatchObject({ total: 2, returned: 2, truncated: false })
  })

  it('filters by name query, case-insensitively', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { query: 'ALPHA' } },
      r
    )
    expect(r.body.projects.map(p => p.id)).toEqual(['p2'])
  })

  it('filters by ownership', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const owned = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { ownership: 'owned' } },
      owned
    )
    expect(owned.body.projects.map(p => p.id)).toEqual(['p1'])

    const shared = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { ownership: 'shared' } },
      shared
    )
    expect(shared.body.projects.map(p => p.id)).toEqual(['p2'])
  })

  it('sorts by name ascending when asked, and honours an explicit order', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const byName = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { sortBy: 'name' } },
      byName
    )
    expect(byName.body.projects.map(p => p.id)).toEqual(['p2', 'p1'])

    const reversed = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { sortBy: 'name', order: 'desc' } },
      reversed
    )
    expect(reversed.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
  })

  it('pages with limit and reports total and truncation', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { limit: '1' } },
      r
    )
    expect(r.body.projects.map(p => p.id)).toEqual(['p1'])
    expect(r.body).toMatchObject({ total: 2, returned: 1, truncated: true })
  })

  it('reports a project once even when several access buckets list it', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      ...sample,
      readAndWrite: [sample.owned[0]],
    })
    const r = res()
    await McpProjectsController.listProjects({ mcpUserId: 'u1', query: {} }, r)
    expect(r.body.projects.map(p => [p.id, p.accessLevel])).toEqual([
      ['p1', 'owner'],
    ])
  })

  it('excludes trashed and archived projects by default (status: active)', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [
        { _id: 'p1', name: 'Active', trashed: [], archived: [] },
        { _id: 'p2', name: 'InTrash', trashed: ['u1'], archived: [] },
        { _id: 'p3', name: 'Archived', trashed: [], archived: ['u1'] },
      ],
      readAndWrite: [],
      readOnly: [],
    })
    const r = res()
    await McpProjectsController.listProjects({ mcpUserId: 'u1', query: {} }, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1'])
    expect(r.body.projects[0]).toMatchObject({ trashed: false, archived: false })
  })

  it('returns only trashed projects when status=trashed', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [
        { _id: 'p1', name: 'Active', trashed: [] },
        { _id: 'p2', name: 'InTrash', trashed: ['u1'] },
      ],
      readAndWrite: [],
      readOnly: [],
    })
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { status: 'trashed' } },
      r
    )
    expect(r.body.projects.map(p => p.id)).toEqual(['p2'])
    expect(r.body.projects[0].trashed).toBe(true)
  })

  it('returns only archived projects when status=archived', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [
        { _id: 'p1', name: 'Active', archived: [] },
        { _id: 'p2', name: 'InArchive', archived: ['u1'] },
      ],
      readAndWrite: [],
      readOnly: [],
    })
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { status: 'archived' } },
      r
    )
    expect(r.body.projects.map(p => p.id)).toEqual(['p2'])
    expect(r.body.projects[0].archived).toBe(true)
  })

  it('returns all projects when status=all', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [
        { _id: 'p1', name: 'Active', trashed: [] },
        { _id: 'p2', name: 'InTrash', trashed: ['u1'] },
      ],
      readAndWrite: [],
      readOnly: [],
    })
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { status: 'all' } },
      r
    )
    expect(r.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.body.projects[1].trashed).toBe(true)
  })

  it('rejects invalid status values and lists the allowed ones', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { status: 'deleted_forever' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(r.body.details.allowed).toEqual(['active', 'archived', 'trashed', 'all'])
  })

  it('rejects a limit below 1 or not a whole number', async () => {
    for (const limit of ['0', '1.5', 'all']) {
      const r = res()
      await McpProjectsController.listProjects(
        { mcpUserId: 'u1', query: { limit } },
        r
      )
      expect(r.statusCode, limit).toBe(400)
    }
    expect(ProjectGetter.promises.findAllUsersProjects).not.toHaveBeenCalled()
  })

  it('accepts a limit above 200', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue(sample)
    const r = res()
    await McpProjectsController.listProjects(
      { mcpUserId: 'u1', query: { limit: '500' } },
      r
    )
    expect(r.statusCode).toBe(200)
    expect(r.body).toMatchObject({ total: 2, returned: 2, truncated: false })
  })
})

describe('McpProjectsController.createProject', () => {
  it('validates the name', async () => {
    const req = { mcpUserId: 'u1', body: {} }
    const r = res()
    await McpProjectsController.createProject(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })

  it('rejects an unknown template and lists the allowed ones', async () => {
    const r = res()
    await McpProjectsController.createProject(
      { mcpUserId: 'u1', body: { name: 'P', template: 'thesis' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.details.allowed).toEqual(['blank', 'example', 'empty'])
    expect(ProjectCreationHandler.promises.createBasicProject).not.toHaveBeenCalled()
  })

  it('returns the name validation message rather than an upstream error', async () => {
    ProjectDetailsHandler.promises.validateProjectName.mockRejectedValue(
      new Errors.InvalidNameError('Project name is too long')
    )
    const r = res()
    await McpProjectsController.createProject(
      { mcpUserId: 'u1', body: { name: 'x'.repeat(200) } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toBe('Project name is too long')
    expect(ProjectCreationHandler.promises.createBasicProject).not.toHaveBeenCalled()
  })

  it('rejects invalid initialFiles upfront without creating a project', async () => {
    const r1 = res()
    await McpProjectsController.createProject(
      {
        mcpUserId: 'u1',
        body: { name: 'P', initialFiles: [{ path: 'valid.tex' }, { path: null }] },
      },
      r1
    )
    expect(r1.statusCode).toBe(400)
    expect(r1.body.message).toContain('each initial file needs a path')

    const r2 = res()
    await McpProjectsController.createProject(
      {
        mcpUserId: 'u1',
        body: { name: 'P', initialFiles: [{ path: '../secret.tex' }] },
      },
      r2
    )
    expect(r2.statusCode).toBe(400)
    expect(r2.body.message).toContain('invalid path in initialFiles')
    expect(ProjectCreationHandler.promises.createBasicProject).not.toHaveBeenCalled()
  })

  it('rejects a file name the editor would refuse before creating the project', async () => {
    const r = res()
    await McpProjectsController.createProject(
      {
        mcpUserId: 'u1',
        body: { name: 'P', initialFiles: [{ path: 'bad*name.tex' }] },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(ProjectCreationHandler.promises.createBasicProject).not.toHaveBeenCalled()
  })

  it('creates a blank project by default, replaces main.tex with mainTex, and reports the root document', async () => {
    ProjectCreationHandler.promises.createBasicProject.mockResolvedValue({
      _id: 'pNew',
      name: 'Paper',
      lastUpdated: '2026-04-01T00:00:00.000Z',
    })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(
      tree({ docs: [['d1', 'main.tex'], ['d2', 'refs.bib']] })
    )
    const r = res()
    await McpProjectsController.createProject(
      {
        mcpUserId: 'u1',
        body: {
          name: 'Paper',
          initialFiles: [{ path: 'refs.bib', content: 'x' }],
          mainTex: 'a\nb',
        },
      },
      r
    )
    expect(ProjectCreationHandler.promises.createBasicProject).toHaveBeenCalledWith(
      'u1',
      'Paper'
    )
    expect(EditorController.promises.upsertDocWithPath).toHaveBeenNthCalledWith(
      1,
      'pNew',
      '/refs.bib',
      ['x'],
      'mcp',
      'u1'
    )
    expect(EditorController.promises.upsertDocWithPath).toHaveBeenLastCalledWith(
      'pNew',
      '/main.tex',
      ['a', 'b'],
      'mcp',
      'u1'
    )
    expect(EditorController.promises.setRootDoc).toHaveBeenCalledWith('pNew', 'd1')
    expect(r.body).toMatchObject({
      project: { id: 'pNew', accessLevel: 'owner' },
      rootDocPath: '/main.tex',
      filesCreated: ['/refs.bib', '/main.tex'],
    })
  })

  it('uses the example template when asked', async () => {
    ProjectCreationHandler.promises.createExampleProject.mockResolvedValue({
      _id: 'pEx',
      name: 'Demo',
      rootDoc_id: 'd1',
    })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(
      tree({ docs: [['d1', 'main.tex']] })
    )
    const r = res()
    await McpProjectsController.createProject(
      { mcpUserId: 'u1', body: { name: 'Demo', template: 'example' } },
      r
    )
    expect(ProjectCreationHandler.promises.createExampleProject).toHaveBeenCalledWith(
      'u1',
      'Demo'
    )
    expect(EditorController.promises.setRootDoc).not.toHaveBeenCalled()
    expect(r.body.rootDocPath).toBe('/main.tex')
  })

  it('deletes the project again when adding its files fails, so a retry does not duplicate it', async () => {
    ProjectCreationHandler.promises.createBasicProject.mockResolvedValue({
      _id: 'pHalf',
      name: 'Paper',
    })
    EditorController.promises.upsertDocWithPath.mockRejectedValueOnce(
      new Error('docstore down')
    )
    const err = await McpProjectsController.createProject(
      {
        mcpUserId: 'u1',
        body: { name: 'Paper', initialFiles: [{ path: 'a.tex' }] },
        ip: '10.0.0.1',
      },
      res()
    ).catch(e => e)
    expect(err.message).toBe('docstore down')
    expect(ProjectDeleter.promises.deleteProject).toHaveBeenCalledWith(
      'pHalf',
      expect.objectContaining({
        deleterUser: { _id: 'u1' },
        ipAddress: '10.0.0.1',
      })
    )
  })

  it('reports the half-created project id when it cannot be deleted either', async () => {
    ProjectCreationHandler.promises.createBasicProject.mockResolvedValue({
      _id: 'pStuck',
      name: 'Paper',
    })
    EditorController.promises.upsertDocWithPath.mockRejectedValueOnce(
      new Error('docstore down')
    )
    ProjectDeleter.promises.deleteProject.mockRejectedValueOnce(
      new Error('mongo down')
    )
    const r = res()
    await McpProjectsController.createProject(
      { mcpUserId: 'u1', body: { name: 'Paper', initialFiles: [{ path: 'a.tex' }] } },
      r
    )
    expect(r.statusCode).toBe(502)
    expect(r.body.code).toBe('upstream_error')
    expect(r.body.details).toEqual({ projectId: 'pStuck' })
  })

  it('leaves the root document unset for an empty project with no main.tex', async () => {
    ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
      _id: 'pE',
      name: 'Empty',
    })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(tree())
    const r = res()
    await McpProjectsController.createProject(
      { mcpUserId: 'u1', body: { name: 'Empty', template: 'empty' } },
      r
    )
    expect(ProjectCreationHandler.promises.createBlankProject).toHaveBeenCalledWith(
      'u1',
      'Empty'
    )
    expect(r.body.rootDocPath).toBeNull()
    expect(EditorController.promises.setRootDoc).not.toHaveBeenCalled()
  })
})

describe('McpProjectsController.getProject', () => {
  const project = {
    _id: 'p1',
    name: 'Thesis',
    compiler: 'xelatex',
    imageName: 'registry.example/texlive/x:2024',
    rootDoc_id: 'd1',
    spellCheckLanguage: 'en',
    owner_ref: 'u2',
    archived: [],
    trashed: [],
  }

  beforeEach(() => {
    Settings.imageRoot = 'registry.example'
    Settings.allowedImageNames = [
      { imageName: 'texlive/x:2024', imageDesc: 'TeX Live 2024' },
    ]
    UserGetter.promises.getUsers.mockResolvedValue([
      { _id: 'u2', first_name: 'Ada', last_name: 'Lovelace' },
    ])
    AuthorizationManager.promises.getPrivilegeLevelForProject.mockResolvedValue(
      'readAndWrite'
    )
    AuthorizationManager.promises.canUserWriteProjectSettings.mockResolvedValue(true)
    AuthorizationManager.promises.canUserAdminProject.mockResolvedValue(false)
  })

  it('returns not_found for a missing project', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue(null)
    const r = res()
    await McpProjectsController.getProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' } },
      r
    )
    expect(r.statusCode).toBe(404)
  })

  it('returns settings with bare values, allowed values, and file counts', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue(project)
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(
      tree({
        docs: [['d1', 'main.tex'], ['d2', 'appendix.tex'], ['d3', 'refs.bib']],
        files: [['f1', 'fig.png']],
      })
    )
    const r = res()
    await McpProjectsController.getProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' } },
      r
    )
    expect(r.body.project).toMatchObject({
      id: 'p1',
      accessLevel: 'readAndWrite',
      canWrite: true,
      canAdmin: false,
      owner: { id: 'u2', name: 'Ada Lovelace' },
    })
    expect(r.body.settings).toEqual({
      name: 'Thesis',
      compiler: 'xelatex',
      imageName: 'texlive/x:2024',
      spellCheckLanguage: 'en',
      rootDocPath: '/main.tex',
      rootDocId: 'd1',
    })
    expect(r.body.allowedValues.compiler).toEqual(Settings.safeCompilers)
    expect(r.body.allowedValues.imageName).toEqual([
      { value: 'texlive/x:2024', description: 'TeX Live 2024' },
    ])
    expect(r.body.allowedValues.spellCheckLanguage[0]).toEqual({
      value: '',
      name: 'Spell check off',
    })
    expect(r.body.files).toEqual({
      documents: 3,
      files: 1,
      rootDocCandidates: ['/main.tex', '/appendix.tex'],
    })
  })

  it('reports a null root document when none is set', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      ...project,
      rootDoc_id: undefined,
    })
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(tree())
    const r = res()
    await McpProjectsController.getProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' } },
      r
    )
    expect(r.body.settings.rootDocPath).toBeNull()
    expect(r.body.settings.rootDocId).toBeNull()
  })
})

describe('McpProjectsController.updateSettings', () => {
  const project = {
    _id: 'p1',
    name: 'Thesis',
    compiler: 'xelatex',
    spellCheckLanguage: 'en',
    rootDoc_id: 'd1',
    owner_ref: 'u1',
  }
  const entities = tree({
    docs: [['d1', 'main.tex'], ['d2', 'appendix.tex'], ['d3', 'refs.bib']],
  })

  beforeEach(() => {
    ProjectGetter.promises.getProject.mockResolvedValue(project)
    ProjectEntityHandler.promises.getAllEntities.mockResolvedValue(entities)
  })

  it('rejects an empty settings body and lists the settings it accepts', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.details.allowed).toContain('rootDocPath')
    expect(EditorController.promises.setCompiler).not.toHaveBeenCalled()
  })

  it('rejects an unsupported compiler with the allowed values and changes nothing', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { compiler: 'pdftex', spellCheckLanguage: 'en_US' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.details.allowed).toEqual(Settings.safeCompilers)
    expect(EditorController.promises.setSpellCheckLanguage).not.toHaveBeenCalled()
  })

  it('accepts a compiler regardless of letter case', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { compiler: 'PDFLATEX' } },
      r
    )
    expect(EditorController.promises.setCompiler).toHaveBeenCalledWith('p1', 'pdflatex')
    expect(r.body.changes[0]).toMatchObject({
      field: 'compiler',
      before: 'xelatex',
      after: 'pdflatex',
      changed: true,
    })
  })

  it('refuses imageName when the server offers no TeX Live images', async () => {
    Settings.allowedImageNames = undefined
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { imageName: 'texlive/x:2024' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toContain('cannot be changed')
    expect(EditorController.promises.setImageName).not.toHaveBeenCalled()
  })

  it('resolves imageName against the offered images', async () => {
    Settings.allowedImageNames = [
      { imageName: 'texlive/x:2024', imageDesc: 'TeX Live 2024' },
    ]
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { imageName: 'TeXLive/X:2024' },
      },
      r
    )
    expect(EditorController.promises.setImageName).toHaveBeenCalledWith(
      'p1',
      'texlive/x:2024'
    )
    expect(r.body.changes[0].after).toBe('texlive/x:2024')
  })

  it('rejects an unknown spell-check language and lists the allowed codes', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { spellCheckLanguage: 'klingon' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.details.allowed).toContain('en_US')
    expect(r.body.details.allowed).toContain('')
  })

  it('resolves rootDocPath to the document id and reports the change', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: 'appendix.tex' },
      },
      r
    )
    expect(EditorController.promises.setRootDoc).toHaveBeenCalledWith('p1', 'd2')
    expect(r.body.changes).toEqual([
      {
        field: 'rootDocPath',
        before: '/main.tex',
        after: '/appendix.tex',
        changed: true,
      },
    ])
    expect(r.body.settings.rootDocId).toBe('d2')
  })

  it('returns not_found with the root document candidates for an unknown path', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: '/paper.tex' },
      },
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.details.rootDocCandidates).toEqual([
      '/main.tex',
      '/appendix.tex',
    ])
    expect(EditorController.promises.setRootDoc).not.toHaveBeenCalled()
  })

  it('rejects a root document that is not a LaTeX file', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocPath: 'refs.bib' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toContain('cannot be a root document')
    expect(EditorController.promises.setRootDoc).not.toHaveBeenCalled()
  })

  it('accepts rootDocId as an alternative to rootDocPath, but not both', async () => {
    const byId = res()
    await McpProjectsController.updateSettings(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { rootDocId: 'd2' } },
      byId
    )
    expect(EditorController.promises.setRootDoc).toHaveBeenCalledWith('p1', 'd2')

    const both = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { rootDocId: 'd2', rootDocPath: '/main.tex' },
      },
      both
    )
    expect(both.statusCode).toBe(400)
  })

  it('refuses a rename from someone who cannot rename the project, changing nothing', async () => {
    AuthorizationManager.promises.canUserRenameProject.mockResolvedValue(false)
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { name: 'Hijacked', compiler: 'lualatex' },
      },
      r
    )
    expect(r.statusCode).toBe(403)
    expect(r.body.code).toBe('forbidden')
    expect(EditorController.promises.renameProject).not.toHaveBeenCalled()
    expect(EditorController.promises.setCompiler).not.toHaveBeenCalled()
  })

  it('validates the new name before writing anything', async () => {
    ProjectDetailsHandler.promises.validateProjectName.mockRejectedValue(
      new Errors.InvalidNameError('Project name cannot be blank')
    )
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: { name: '   ', compiler: 'lualatex' },
      },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.message).toBe('Project name cannot be blank')
    expect(EditorController.promises.setCompiler).not.toHaveBeenCalled()
  })

  it('applies several settings and reports each one with before and after', async () => {
    const r = res()
    await McpProjectsController.updateSettings(
      {
        mcpUserId: 'u1',
        params: { projectId: 'p1' },
        body: {
          name: '  Thesis v2 ',
          compiler: 'pdflatex',
          spellCheckLanguage: 'en',
        },
      },
      r
    )
    expect(EditorController.promises.renameProject).toHaveBeenCalledWith(
      'p1',
      'Thesis v2'
    )
    expect(EditorController.promises.setCompiler).toHaveBeenCalledWith('p1', 'pdflatex')
    expect(r.body.changes).toEqual([
      { field: 'name', before: 'Thesis', after: 'Thesis v2', changed: true },
      { field: 'compiler', before: 'xelatex', after: 'pdflatex', changed: true },
      { field: 'spellCheckLanguage', before: 'en', after: 'en', changed: false },
    ])
    expect(r.body.settings).toMatchObject({
      name: 'Thesis v2',
      compiler: 'pdflatex',
      rootDocPath: '/main.tex',
    })
  })
})

describe('McpProjectsController.setStatus', () => {
  it('rejects an unknown status and lists the allowed ones', async () => {
    const r = res()
    await McpProjectsController.setStatus(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { status: 'deleted' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.details.allowed).toEqual(['active', 'archived', 'trashed'])
  })

  it('moves an active project to the trash', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      _id: 'p1',
      archived: [],
      trashed: [],
    })
    const r = res()
    await McpProjectsController.setStatus(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { status: 'trashed' } },
      r
    )
    expect(ProjectDeleter.promises.trashProject).toHaveBeenCalledWith('p1', 'u1')
    expect(r.body).toEqual({
      projectId: 'p1',
      previousStatus: 'active',
      status: 'trashed',
    })
  })

  it('restores a trashed project to active by untrashing it', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      _id: 'p1',
      archived: [],
      trashed: ['u1'],
    })
    const r = res()
    await McpProjectsController.setStatus(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { status: 'active' } },
      r
    )
    expect(ProjectDeleter.promises.untrashProject).toHaveBeenCalledWith('p1', 'u1')
    expect(ProjectDeleter.promises.unarchiveProject).not.toHaveBeenCalled()
    expect(r.body.previousStatus).toBe('trashed')
  })

  it('does nothing when the project already has the requested status', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      _id: 'p1',
      archived: ['u1'],
      trashed: [],
    })
    const r = res()
    await McpProjectsController.setStatus(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { status: 'archived' } },
      r
    )
    expect(ProjectDeleter.promises.archiveProject).not.toHaveBeenCalled()
    expect(r.body.previousStatus).toBe('archived')
  })
})

describe('McpProjectsController.copyProject', () => {
  it('copies into a unique "(Copy)" name when no name is given', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({ _id: 'p1', name: 'Thesis' })
    ProjectDetailsHandler.promises.generateUniqueName.mockResolvedValue(
      'Thesis (Copy)'
    )
    ProjectDuplicator.promises.duplicate.mockResolvedValue({
      _id: 'p9',
      name: 'Thesis (Copy)',
      lastUpdated: '2026-05-01T00:00:00.000Z',
      compiler: 'pdflatex',
    })
    const r = res()
    await McpProjectsController.copyProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} },
      r
    )
    expect(ProjectDetailsHandler.promises.generateUniqueName).toHaveBeenCalledWith(
      'u1',
      'Thesis (Copy)'
    )
    expect(ProjectDuplicator.promises.duplicate).toHaveBeenCalledWith(
      { _id: 'u1' },
      'p1',
      'Thesis (Copy)',
      [],
      { isDebugCopy: false, cloneHistory: false, cloneRanges: false }
    )
    expect(r.body.project).toMatchObject({
      id: 'p9',
      name: 'Thesis (Copy)',
      accessLevel: 'owner',
    })
    expect(r.body.sourceProjectId).toBe('p1')
  })

  it('rejects an invalid requested name before copying', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({ _id: 'p1', name: 'Thesis' })
    ProjectDetailsHandler.promises.validateProjectName.mockRejectedValue(
      new Errors.InvalidNameError('Project name cannot contain / characters')
    )
    const r = res()
    await McpProjectsController.copyProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { name: 'a/b' } },
      r
    )
    expect(r.statusCode).toBe(400)
    expect(ProjectDuplicator.promises.duplicate).not.toHaveBeenCalled()
  })
})

describe('McpProjectsController.deleteProject', () => {
  it('refuses when the caller is not the project owner', async () => {
    AuthorizationManager.promises.canUserAdminProject.mockResolvedValue(false)
    const r = res()
    await McpProjectsController.deleteProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, ip: '10.0.0.1' },
      r
    )
    expect(r.statusCode).toBe(403)
    expect(ProjectDeleter.promises.deleteProject).not.toHaveBeenCalled()
  })

  it('deletes the project for its owner and audits the deletion', async () => {
    const r = res()
    await McpProjectsController.deleteProject(
      { mcpUserId: 'u1', params: { projectId: 'p1' }, ip: '10.0.0.1' },
      r
    )
    expect(ProjectDeleter.promises.deleteProject).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        deleterUser: { _id: 'u1' },
        ipAddress: '10.0.0.1',
        deletedReason: 'user',
      })
    )
    expect(ProjectAuditLogHandler.addEntryIfManagedInBackground).toHaveBeenCalledWith(
      'p1',
      'project-deleted',
      'u1',
      '10.0.0.1'
    )
    expect(r.body).toEqual({ projectId: 'p1', deleted: true })
  })
})
