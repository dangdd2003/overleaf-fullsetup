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
    ])

    const allTools = groups.flatMap(g => g.tools)
    expect(allTools).to.have.length(20)
    expect(byKey.projects.tools.map(t => t.name)).to.have.members([
      'list_projects',
      'create_project',
      'get_project',
      'update_project',
      'export_project_zip',
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
})
