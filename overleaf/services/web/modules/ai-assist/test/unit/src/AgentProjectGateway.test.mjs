import { describe, it, beforeEach, vi } from 'vitest'
import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mockAuth = vi.hoisted(() => ({
  canUserReadProject: vi.fn(async () => true),
  canUserWriteProjectContent: vi.fn(async () => true),
}))
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
  () => ({ default: { promises: mockAuth } })
)

const { assertProjectAccess, runInProjectScope, projectGateway } = await import(
  '../../../app/src/AgentProjectGateway.mjs'
)

const APP_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../app/src'
)
const USER = '012345678901234567890123'

describe('assertProjectAccess', function () {
  beforeEach(function () {
    mockAuth.canUserReadProject.mockReset().mockResolvedValue(true)
    mockAuth.canUserWriteProjectContent.mockReset().mockResolvedValue(true)
  })

  it('checks read and write through AuthorizationManager', async function () {
    await assertProjectAccess('p1', USER, 'read')
    await assertProjectAccess('p1', USER, 'write')
    expect(mockAuth.canUserReadProject.mock.calls[0].slice(0, 2)).to.deep.equal([USER, 'p1'])
    expect(mockAuth.canUserWriteProjectContent.mock.calls[0].slice(0, 2)).to.deep.equal([USER, 'p1'])
  })

  it('throws accessRevoked when the user lost access', async function () {
    mockAuth.canUserWriteProjectContent.mockResolvedValue(false)
    let caught
    try {
      await assertProjectAccess('p1', USER, 'write')
    } catch (err) {
      caught = err
    }
    expect(caught?.code).to.equal('accessRevoked')
  })

  it('refuses a gateway read with no project scope', async function () {
    let caught
    try {
      await projectGateway.projectGetter.getProject('p1', {})
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.an('error')
  })

  it('refuses a gateway call for another project than the scope', async function () {
    let caught
    await runInProjectScope({ projectId: 'p1', userId: USER }, async () => {
      try {
        await projectGateway.projectGetter.getProject('p2', {})
      } catch (err) {
        caught = err
      }
    })
    expect(caught?.code).to.equal('accessRevoked')
  })
})

describe('import boundary', function () {
  const GUARDED = [
    path.join(APP_SRC, 'AiAssistTools.mjs'),
    path.join(APP_SRC, 'AiAssistWebTools.mjs'),
    path.join(APP_SRC, 'connectors', 'ConnectorRuntime.mjs'),
  ]
  // Empty: nothing in these files may import core directly.
  const ALLOWED_EXCEPTIONS = []

  for (const file of GUARDED) {
    it(`${path.basename(file)} reaches core only through the gateway`, function () {
      const source = fs.readFileSync(file, 'utf8')
      const specs = [
        ...source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g),
        ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map(m => m[1])
      const direct = specs.filter(
        spec =>
          /(^|\/)app\/src\/Features\//.test(spec) &&
          !ALLOWED_EXCEPTIONS.includes(spec)
      )
      expect(direct).to.deep.equal([])
    })
  }
})
