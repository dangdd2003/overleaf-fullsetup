import { describe, it, expect, vi, beforeEach } from 'vitest'

const TagsHandler = {
  promises: {
    getAllTags: vi.fn(),
    createTag: vi.fn(),
    editTag: vi.fn(),
    deleteTag: vi.fn(),
    addProjectsToTag: vi.fn(),
    removeProjectsFromTag: vi.fn(),
  },
}
const ProjectGetter = { promises: { findAllUsersProjects: vi.fn() } }

vi.mock('../../../../../app/src/Features/Tags/TagsHandler.mjs', () => ({
  default: TagsHandler,
}))
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: ProjectGetter,
}))

const { default: McpTagsController } = await import(
  '../../../app/src/McpTagsController.mjs'
)

const TAG_ID = 'a'.repeat(24)
const OTHER_ID = 'b'.repeat(24)

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
    setHeader() {},
  }
}

function tag(overrides = {}) {
  return {
    _id: TAG_ID,
    name: 'thesis',
    color: '#3366CC',
    project_ids: ['p1', 'p2'],
    ...overrides,
  }
}

function req(overrides = {}) {
  return { mcpUserId: 'u1', params: {}, query: {}, body: {}, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  TagsHandler.promises.getAllTags.mockResolvedValue([tag()])
})

describe('McpTagsController.listTags', () => {
  it('returns tags sorted by name with counts, and ids only on request', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([
      tag({ _id: OTHER_ID, name: 'zeta', color: undefined, project_ids: [] }),
      tag(),
    ])
    const r = res()
    await McpTagsController.listTags(req(), r)
    expect(r.body.total).toBe(2)
    expect(r.body.tags.map(t => t.name)).toEqual(['thesis', 'zeta'])
    expect(r.body.tags[1].color).toBeNull()
    expect(r.body.tags[0]).toEqual({
      id: TAG_ID,
      name: 'thesis',
      color: '#3366CC',
      projectCount: 2,
    })

    const withIds = res()
    await McpTagsController.listTags(
      req({ query: { includeProjects: 'true' } }),
      withIds
    )
    expect(withIds.body.tags[0].projectIds).toEqual(['p1', 'p2'])
  })
})

describe('McpTagsController.createTag', () => {
  it('creates a new tag', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    TagsHandler.promises.createTag.mockResolvedValue(tag({ project_ids: [] }))
    const r = res()
    await McpTagsController.createTag(
      req({ body: { name: ' thesis ', color: '#3366CC' } }),
      r
    )
    expect(TagsHandler.promises.createTag).toHaveBeenCalledWith(
      'u1',
      'thesis',
      '#3366CC'
    )
    expect(r.body.created).toBe(true)
  })

  it('returns the existing tag when the name is taken', async () => {
    const r = res()
    await McpTagsController.createTag(req({ body: { name: 'thesis' } }), r)
    expect(TagsHandler.promises.createTag).not.toHaveBeenCalled()
    expect(r.body.created).toBe(false)
    expect(r.body.tag.id).toBe(TAG_ID)
  })

  it('is a 409 when a concurrent create wins the unique index', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    TagsHandler.promises.createTag.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    )
    const r = res()
    await McpTagsController.createTag(req({ body: { name: 'thesis' } }), r)
    expect(r.statusCode).toBe(409)
    expect(r.body.code).toBe('conflict')
  })

  it('passes other create failures through as errors', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    TagsHandler.promises.createTag.mockRejectedValue(new Error('mongo down'))
    const err = await McpTagsController.createTag(
      req({ body: { name: 'thesis' } }),
      res()
    ).catch(e => e)
    expect(err.message).toBe('mongo down')
  })

  it('accepts a name of exactly 50 characters', async () => {
    const name = 'x'.repeat(50)
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    TagsHandler.promises.createTag.mockResolvedValue(
      tag({ name, project_ids: [] })
    )
    const r = res()
    await McpTagsController.createTag(req({ body: { name } }), r)
    expect(r.statusCode).toBe(200)
    expect(TagsHandler.promises.createTag).toHaveBeenCalledWith('u1', name, undefined)
  })

  it('rejects a name over 50 characters as a validation error, before the upstream call', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    const r = res()
    await McpTagsController.createTag(
      req({ body: { name: 'x'.repeat(51) } }),
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(TagsHandler.promises.createTag).not.toHaveBeenCalled()
  })

  it.each([
    [{ name: '' }],
    [{ name: 5 }],
    [{ name: 'ok', color: 'red' }],
    [{ name: 'ok', color: 'hsl(1, 70%, 45%)' }],
  ])('rejects %j', async body => {
    TagsHandler.promises.getAllTags.mockResolvedValue([])
    const r = res()
    await McpTagsController.createTag(req({ body }), r)
    expect(r.statusCode).toBe(400)
    expect(TagsHandler.promises.createTag).not.toHaveBeenCalled()
  })
})

describe('McpTagsController.updateTag', () => {
  it('renames and keeps the colour, reporting before values', async () => {
    const r = res()
    await McpTagsController.updateTag(
      req({ params: { tagId: TAG_ID }, body: { name: 'diss' } }),
      r
    )
    expect(TagsHandler.promises.editTag).toHaveBeenCalledWith(
      'u1',
      TAG_ID,
      'diss',
      '#3366CC'
    )
    expect(r.body.tag.name).toBe('diss')
    expect(r.body.before).toEqual({ name: 'thesis', color: '#3366CC' })
  })

  it('rejects a rename to more than 50 characters as a validation error', async () => {
    const r = res()
    await McpTagsController.updateTag(
      req({ params: { tagId: TAG_ID }, body: { name: 'x'.repeat(51) } }),
      r
    )
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
    expect(TagsHandler.promises.editTag).not.toHaveBeenCalled()
  })

  it('requires name or color', async () => {
    const r = res()
    await McpTagsController.updateTag(req({ params: { tagId: TAG_ID } }), r)
    expect(r.statusCode).toBe(400)
  })

  it('is a 409 when another tag has the name', async () => {
    TagsHandler.promises.getAllTags.mockResolvedValue([
      tag(),
      tag({ _id: OTHER_ID, name: 'diss' }),
    ])
    const r = res()
    await McpTagsController.updateTag(
      req({ params: { tagId: TAG_ID }, body: { name: 'diss' } }),
      r
    )
    expect(r.statusCode).toBe(409)
    expect(TagsHandler.promises.editTag).not.toHaveBeenCalled()
  })

  it('is a 404 for an unknown or malformed tag id', async () => {
    for (const tagId of [OTHER_ID, 'not-an-id']) {
      const r = res()
      await McpTagsController.updateTag(
        req({ params: { tagId }, body: { name: 'x' } }),
        r
      )
      expect(r.statusCode).toBe(404)
    }
  })
})

describe('McpTagsController.deleteTag', () => {
  it('deletes and reports how many projects lost the tag', async () => {
    const r = res()
    await McpTagsController.deleteTag(req({ params: { tagId: TAG_ID } }), r)
    expect(TagsHandler.promises.deleteTag).toHaveBeenCalledWith('u1', TAG_ID)
    expect(r.body).toEqual({
      tagId: TAG_ID,
      name: 'thesis',
      deleted: true,
      projectsUntagged: 2,
    })
  })

  it('is a 404 for a tag the caller does not own', async () => {
    const r = res()
    await McpTagsController.deleteTag(req({ params: { tagId: OTHER_ID } }), r)
    expect(r.statusCode).toBe(404)
    expect(TagsHandler.promises.deleteTag).not.toHaveBeenCalled()
  })
})

describe('McpTagsController.addProjects', () => {
  beforeEach(() => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [{ _id: 'p1' }, { _id: 'p3' }],
      readOnly: [{ _id: 'p4' }],
    })
  })

  it('adds only untagged projects and reports the rest', async () => {
    const r = res()
    await McpTagsController.addProjects(
      req({
        params: { tagId: TAG_ID },
        body: { projectIds: ['p1', 'p3', 'p4', 'p3'] },
      }),
      r
    )
    expect(TagsHandler.promises.addProjectsToTag).toHaveBeenCalledWith(
      'u1',
      TAG_ID,
      ['p3', 'p4']
    )
    expect(r.body.added).toEqual(['p3', 'p4'])
    expect(r.body.alreadyTagged).toEqual(['p1'])
    expect(r.body.tag.projectCount).toBe(4)
  })

  it('tags nothing when any project is not accessible', async () => {
    const r = res()
    await McpTagsController.addProjects(
      req({ params: { tagId: TAG_ID }, body: { projectIds: ['p3', 'nope'] } }),
      r
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.details).toEqual({ unknown: ['nope'] })
    expect(TagsHandler.promises.addProjectsToTag).not.toHaveBeenCalled()
  })

  it('accepts more than 200 projects in one call', async () => {
    const owned = Array.from({ length: 250 }, (_, i) => ({ _id: `p${i}` }))
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({ owned })
    const r = res()
    await McpTagsController.addProjects(
      req({
        params: { tagId: TAG_ID },
        body: { projectIds: owned.map(p => p._id) },
      }),
      r
    )
    expect(r.statusCode).toBe(200)
    // p1 and p2 were already on the tag.
    expect(r.body.added).toHaveLength(248)
    expect(r.body.alreadyTagged).toEqual(['p1', 'p2'])
  })

  it.each([
    [[]],
    ['p1'],
    [['']],
  ])('rejects projectIds %#', async projectIds => {
    const r = res()
    await McpTagsController.addProjects(
      req({ params: { tagId: TAG_ID }, body: { projectIds } }),
      r
    )
    expect(r.statusCode).toBe(400)
  })
})

describe('McpTagsController.removeProjects', () => {
  it('removes tagged projects without needing access to them', async () => {
    const r = res()
    await McpTagsController.removeProjects(
      req({ params: { tagId: TAG_ID }, body: { projectIds: ['p1', 'p9'] } }),
      r
    )
    expect(ProjectGetter.promises.findAllUsersProjects).not.toHaveBeenCalled()
    expect(TagsHandler.promises.removeProjectsFromTag).toHaveBeenCalledWith(
      'u1',
      TAG_ID,
      ['p1']
    )
    expect(r.body.removed).toEqual(['p1'])
    expect(r.body.notTagged).toEqual(['p9'])
    expect(r.body.tag.projectCount).toBe(1)
  })
})
