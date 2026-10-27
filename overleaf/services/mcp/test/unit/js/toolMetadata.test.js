import { expect } from 'chai'
import { listToolMetadata } from '../../../src/server.js'

describe('listToolMetadata', function () {
  it('groups every tool under its category with a name, description and params', function () {
    const groups = listToolMetadata()

    const byKey = Object.fromEntries(groups.map(g => [g.key, g]))
    expect(Object.keys(byKey)).to.have.members([
      'projects',
      'files',
      'compile',
      'latex',
      'history',
      'tags',
      'account-search',
    ])

    const allTools = groups.flatMap(g => g.tools)
    expect(allTools).to.have.length(43)
    expect(byKey.compile.tools.map(t => t.name)).to.include(
      'view_compiled_pdf_page'
    )
    expect(byKey.projects.tools.map(t => t.name)).to.have.members([
      'list_projects',
      'create_project',
      'get_project',
      'update_project',
      'set_project_status',
      'copy_project',
      'delete_project',
      'export_project_zip',
    ])

    expect(byKey.history.tools.map(t => t.name)).to.have.members([
      'list_history',
      'get_history_diff',
      'restore_file',
    ])

    expect(byKey.tags.tools.map(t => t.name)).to.have.members([
      'list_tags',
      'create_tag',
      'update_tag',
      'delete_tag',
      'add_projects_to_tag',
      'remove_projects_from_tag',
    ])
    expect(byKey['account-search'].tools.map(t => t.name)).to.have.members([
      'get_profile',
      'search',
      'fetch',
    ])

    for (const tool of allTools) {
      expect(tool.name, 'name').to.be.a('string').and.not.be.empty
      expect(tool.title, `${tool.name} title`).to.be.a('string').and.not.be
        .empty
      expect(tool.description, `${tool.name} description`).to.be.a('string')
        .and.not.be.empty
      expect(tool.params, `${tool.name} params`).to.be.an('array')
    }
  })

  it('describes each param with its name, type, required flag and description', function () {
    const groups = listToolMetadata()
    const projects = groups.find(g => g.key === 'projects')
    const getProject = projects.tools.find(t => t.name === 'get_project')

    const projectId = getProject.params.find(p => p.name === 'projectId')
    expect(projectId).to.deep.include({
      name: 'projectId',
      type: 'string',
      required: true,
    })
    expect(projectId.description).to.be.a('string').and.not.be.empty
  })

  it('does not require a live client to build the metadata', function () {
    expect(() => listToolMetadata()).to.not.throw()
  })

  it('lists every compiled-PDF tool', function () {
    const names = listToolMetadata()
      .flatMap(g => g.tools)
      .map(t => t.name)
    expect(names).to.include.members([
      'view_compiled_pdf_page',
      'view_compiled_pdf_overview',
      'search_compiled_pdf',
      'resolve_pdf_block',
      'diff_compiled_pdf',
    ])
  })
})
