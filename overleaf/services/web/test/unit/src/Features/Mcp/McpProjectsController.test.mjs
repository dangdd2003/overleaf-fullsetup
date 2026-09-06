import { describe, it, expect, vi, beforeEach } from 'vitest'

const ProjectGetter = {
  promises: { findAllUsersProjects: vi.fn(), getProject: vi.fn() },
}
const ProjectCreationHandler = {
  promises: { createBlankProject: vi.fn() },
}
const EditorController = {
  promises: {
    upsertDocWithPath: vi.fn(),
    setCompiler: vi.fn(),
    setRootDoc: vi.fn(),
    setSpellCheckLanguage: vi.fn(),
  },
}

vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: ProjectGetter,
}))
vi.mock(
  '../../../../../app/src/Features/Project/ProjectCreationHandler.mjs',
  () => ({ default: ProjectCreationHandler })
)
vi.mock('../../../../../app/src/Features/Editor/EditorController.mjs', () => ({
  default: EditorController,
}))

const { default: McpProjectsController } = await import(
  '../../../../../app/src/Features/Mcp/McpProjectsController.mjs'
)

function res() {
  return {
    statusCode: 200,
    body: null,
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

beforeEach(() => vi.clearAllMocks())

describe('McpProjectsController.listProjects', () => {
  it('returns only the calling user projects in a compact shape', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [{ _id: 'p1', name: 'Thesis', compiler: 'pdflatex' }],
      readAndWrite: [{ _id: 'p2', name: 'Shared' }],
      readOnly: [],
      tokenReadAndWrite: [],
      tokenReadOnly: [],
    })
    const req = { mcpUserId: 'u1', query: {} }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.body.projects[0]).toHaveProperty('name', 'Thesis')
    expect(ProjectGetter.promises.findAllUsersProjects).toHaveBeenCalledWith(
      'u1',
      expect.any(Object)
    )
  })

  it('filters by query string', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [
        { _id: 'p1', name: 'Thesis' },
        { _id: 'p2', name: 'Recipes' },
      ],
      readAndWrite: [],
      readOnly: [],
    })
    const req = { mcpUserId: 'u1', query: { query: 'thes' } }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1'])
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
    const req = { mcpUserId: 'u1', query: {} }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1'])
    expect(r.body.projects[0]).toHaveProperty('trashed', false)
    expect(r.body.projects[0]).toHaveProperty('archived', false)
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
    const req = { mcpUserId: 'u1', query: { status: 'trashed' } }
    const r = res()
    await McpProjectsController.listProjects(req, r)
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
    const req = { mcpUserId: 'u1', query: { status: 'archived' } }
    const r = res()
    await McpProjectsController.listProjects(req, r)
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
    const req = { mcpUserId: 'u1', query: { status: 'all' } }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.body.projects[1].trashed).toBe(true)
  })

  it('rejects invalid status values with validation_error', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [],
      readAndWrite: [],
      readOnly: [],
    })
    const req = { mcpUserId: 'u1', query: { status: 'deleted_forever' } }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
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
    expect(ProjectCreationHandler.promises.createBlankProject).not.toHaveBeenCalled()

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
    expect(ProjectCreationHandler.promises.createBlankProject).not.toHaveBeenCalled()
  })

  it('creates a blank project and seeds initial files', async () => {
    ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
      _id: 'pNew',
      name: 'Paper',
    })
    EditorController.promises.upsertDocWithPath.mockResolvedValue({
      doc: { _id: 'd1' },
    })
    const req = {
      mcpUserId: 'u1',
      body: {
        name: 'Paper',
        initialFiles: [{ path: 'main.tex', content: 'a\nb' }],
      },
    }
    const r = res()
    await McpProjectsController.createProject(req, r)
    expect(
      ProjectCreationHandler.promises.createBlankProject
    ).toHaveBeenCalledWith('u1', 'Paper')
    expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
      'pNew',
      '/main.tex',
      ['a', 'b'],
      'mcp',
      'u1'
    )
    expect(r.body.project.id).toBe('pNew')
  })
})

describe('McpProjectsController.getProject', () => {
  it('returns not_found for a missing project', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue(null)
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpProjectsController.getProject(req, r)
    expect(r.statusCode).toBe(404)
  })

  it('returns the project with rootDocId and spellCheckLanguage', async () => {
    ProjectGetter.promises.getProject.mockResolvedValue({
      _id: 'p1',
      name: 'Thesis',
      compiler: 'pdflatex',
      rootDoc_id: { toString: () => 'rd1' },
      spellCheckLanguage: 'en',
    })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' } }
    const r = res()
    await McpProjectsController.getProject(req, r)
    expect(r.body.project).toMatchObject({
      id: 'p1',
      rootDocId: 'rd1',
      spellCheckLanguage: 'en',
    })
  })
})

describe('McpProjectsController.updateSettings', () => {
  it('rejects an empty settings body', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: {} }
    const r = res()
    await McpProjectsController.updateSettings(req, r)
    expect(r.statusCode).toBe(400)
  })

  it('applies each provided setting via EditorController', async () => {
    const req = {
      mcpUserId: 'u1',
      params: { projectId: 'p1' },
      body: { compiler: 'xelatex', rootDocId: 'rd1', spellCheckLanguage: 'fr' },
    }
    const r = res()
    await McpProjectsController.updateSettings(req, r)
    expect(EditorController.promises.setCompiler).toHaveBeenCalledWith(
      'p1',
      'xelatex'
    )
    expect(EditorController.promises.setRootDoc).toHaveBeenCalledWith('p1', 'rd1')
    expect(
      EditorController.promises.setSpellCheckLanguage
    ).toHaveBeenCalledWith('p1', 'fr')
    expect(r.body.status).toBe('ok')
  })
})
