import { expect } from 'chai'
import {
  createFileTool,
  validateNewPath,
} from '../../../../frontend/js/features/ai-assist/agent/tools/create-file'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = { 'main.tex': '\\documentclass{article}' }

describe('validateNewPath', function () {
  const existing = ['main.tex']

  it('accepts an ordinary new path', function () {
    expect(validateNewPath('sections/new.tex', existing)).to.equal(null)
  })

  it('rejects a path that already exists', function () {
    expect(validateNewPath('main.tex', existing)).to.include('already exists')
  })

  it('rejects traversal', function () {
    expect(validateNewPath('../escape.tex', existing)).to.include('..')
  })

  it('rejects an absolute path', function () {
    expect(validateNewPath('/etc/passwd', existing)).to.match(/absolute|relative/i)
  })

  it('rejects a binary extension', function () {
    expect(validateNewPath('figure.pdf', existing)).to.include('binary')
  })
})

describe('create_file', function () {
  it('suspends, because the user must approve it', function () {
    expect(createFileTool.suspends).to.equal(true)
  })

  it('creates a file and reports success', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute(
      { path: 'sections/new.tex', content: '\\section{New}' },
      handle
    )

    expect(result.status).to.equal('applied')
    const call = calls.find(entry => entry.name === 'createFile')
    expect(call!.args).to.deep.equal({
      path: 'sections/new.tex',
      content: '\\section{New}',
    })
  })

  it('refuses to overwrite an existing file', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute(
      { path: 'main.tex', content: 'x' },
      handle
    )

    expect(result.error).to.include('already exists')
    expect(calls.some(entry => entry.name === 'createFile')).to.equal(false)
  })

  it('requires content', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute({ path: 'new.tex', content: '' }, handle)
    expect(result.error).to.match(/content/i)
  })

  it('reports a rejection as a normal outcome, not an error', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onCreate: () => ({ status: 'rejected', note: 'not now' }),
    })
    const result: any = await createFileTool.execute(
      { path: 'new.tex', content: 'x' },
      handle
    )

    expect(result.status).to.equal('rejected')
    expect(result.note).to.equal('not now')
    expect(result.message).to.include('not now')
    expect(result.message).to.match(/acknowledge the rejection/i)
  })

  it('reports a timeout when creating a file', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onCreate: () => ({ status: 'timeout', message: 'Bridge timed out.' } as any),
    })

    const result: any = await createFileTool.execute(
      { path: 'new.tex', content: 'content' },
      handle
    )

    expect(result.status).to.equal('timeout')
    expect(result.message).to.match(/timed out/i)
  })

  it('reports an error when entity creation fails', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onCreate: () => ({ status: 'error', message: 'Failed to create folder.' } as any),
    })

    const result: any = await createFileTool.execute(
      { path: 'sections/new.tex', content: 'content' },
      handle
    )

    expect(result.status).to.equal('error')
    expect(result.message).to.include('Failed to create folder.')
  })
})
