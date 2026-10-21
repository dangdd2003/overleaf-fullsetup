import { expect } from 'chai'
import sinon from 'sinon'
import { registerFileTools } from '../../../../src/tools/files.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

function fakeServer() {
  const tools = new Map()
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, { config, handler })
    },
    call(name, args, ctx = CTX) {
      return tools.get(name).handler(args, ctx)
    },
  }
}

/** The structured envelope every tool returns, for success and error alike. */
function envelope(result) {
  return result.structuredContent
}

/** The compact text block a model reads: the summary line, then the body. */
function textOf(result) {
  return result.content[0].text
}

/** The body of the text block, without its leading summary line. */
function bodyOf(result) {
  return textOf(result).split('\n').slice(1).join('\n')
}

/** A web doc response for a document held as `text`, sliced like web does. */
function docResponse(path, text, startLine, endLine) {
  const lines = text.split('\n')
  const start = startLine ?? 1
  const end = Math.min(endLine ?? lines.length, lines.length)
  return {
    path,
    content: lines.slice(start - 1, end).join('\n'),
    totalLines: lines.length,
    startLine: start,
    endLine: end,
  }
}

describe('file tools', function () {
  let server, client

  beforeEach(function () {
    client = {
      get: sinon.stub(),
      post: sinon.stub(),
      request: sinon.stub(),
      requestBinary: sinon.stub(),
    }
    server = fakeServer()
    registerFileTools(server, {
      client,
      staticToken: '',
    })
  })

  it('registers the ten file tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'list_files',
      'search_files',
      'read_file',
      'write_file',
      'edit_file',
      'edit_lines',
      'move_file',
      'delete_file',
      'upload_asset',
      'download_file',
    ])
  })

  describe('list_files', function () {
    beforeEach(function () {
      client.get.withArgs(TOKEN, '/projects/p1/tree').resolves({
        docs: [
          { path: '/main.tex', id: 'd1' },
          { path: '/chapters/a.tex', id: 'd2' },
        ],
        files: [{ path: '/figures/plot.png', id: 'f1', size: 2048 }],
        folders: [{ path: '/chapters', id: 'fo1' }],
        rootDocPath: '/main.tex',
      })
    })

    it('returns typed entries sorted by path with the root document marked', async function () {
      const data = envelope(await server.call('list_files', { projectId: 'p1' })).data
      expect(data.total).to.equal(4)
      expect(data.rootDocPath).to.equal('/main.tex')
      expect(data.entries.map(e => e.path)).to.deep.equal([
        '/chapters',
        '/chapters/a.tex',
        '/figures/plot.png',
        '/main.tex',
      ])
      expect(data.entries.find(e => e.path === '/main.tex')).to.include({
        type: 'doc',
        root: true,
      })
      expect(data.entries.find(e => e.path === '/figures/plot.png')).to.include({
        type: 'file',
        size: 2048,
      })
    })

    it('filters by type and by glob', async function () {
      const docs = envelope(
        await server.call('list_files', { projectId: 'p1', type: 'docs', glob: '*.tex' })
      ).data
      expect(docs.entries.map(e => e.path)).to.deep.equal([
        '/chapters/a.tex',
        '/main.tex',
      ])
    })

    it('adds an indented tree only when view is tree', async function () {
      const data = envelope(
        await server.call('list_files', { projectId: 'p1', view: 'tree' })
      ).data
      expect(data.tree).to.include('chapters/')
      expect(data.tree).to.include('plot.png  (2K)')
      expect(data.tree).to.include('main.tex  (root)')
      const flat = envelope(await server.call('list_files', { projectId: 'p1' })).data
      expect(flat).to.not.have.property('tree')
    })

    it('renders a flat text list of paths with sizes and the root marked, no folders or ids', async function () {
      const result = await server.call('list_files', { projectId: 'p1' })
      expect(textOf(result)).to.equal(
        [
          '4 entries: 2 docs, 1 files, 1 folders; root /main.tex',
          '/chapters/a.tex',
          '/figures/plot.png  2K',
          '/main.tex  (root)',
        ].join('\n')
      )
      expect(textOf(result)).to.not.include('fo1')
      expect(textOf(result)).to.not.include('"')
    })

    it('lists folder paths with a trailing slash when type is folders', async function () {
      const result = await server.call('list_files', { projectId: 'p1', type: 'folders' })
      expect(textOf(result).split('\n')).to.deep.equal([
        '1 entries: 0 docs, 0 files, 1 folders; root /main.tex',
        '/chapters/',
      ])
    })

    it('shows the indented tree as the text when view is tree', async function () {
      const result = await server.call('list_files', { projectId: 'p1', view: 'tree' })
      expect(bodyOf(result)).to.equal(envelope(result).data.tree)
      expect(textOf(result)).to.include('plot.png  (2K)')
    })
  })

  describe('read_file', function () {
    const MAIN = ['\\documentclass{article}', '\\begin{document}', 'Hi', '\\end{document}'].join('\n')

    beforeEach(function () {
      client.get.callsFake(async (token, path, query = {}) => {
        if (path === '/projects/p1/doc' && query.path === '/main.tex') {
          return docResponse('/main.tex', MAIN, query.startLine, query.endLine)
        }
        if (path === '/projects/p1/doc' && query.path === '/chapters/a.tex') {
          return docResponse('/chapters/a.tex', 'one\ntwo', query.startLine, query.endLine)
        }
        throw new Error(`unexpected read ${path} ${JSON.stringify(query)}`)
      })
    })

    it('returns numbered lines with the range and totals', async function () {
      const result = await server.call('read_file', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 2,
        endLine: 3,
      })
      expect(client.get.firstCall.args[2]).to.deep.equal({
        path: '/main.tex',
        startLine: 2,
        endLine: 3,
      })
      const [doc] = envelope(result).data.documents
      expect(doc).to.deep.include({
        path: '/main.tex',
        totalLines: 4,
        startLine: 2,
        endLine: 3,
        truncated: true,
      })
      expect(doc.content).to.equal('2\t\\begin{document}\n3\tHi')
      expect(bodyOf(result)).to.equal(
        '2\t\\begin{document}\n3\tHi\n→ read_file path=/main.tex startLine=4'
      )
      expect(envelope(result).summary).to.equal('/main.tex 2-3/4')
    })

    it('points at the next range when lines remain', async function () {
      const result = await server.call('read_file', {
        projectId: 'p1',
        path: '/main.tex',
        endLine: 2,
      })
      expect(envelope(result).nextSteps).to.deep.equal(['read_file path=/main.tex startLine=3'])
      expect(textOf(result)).to.not.include('projectId')
    })

    it('reads several documents in one batch request', async function () {
      client.post.callsFake(async (token, path, body) => ({
        documents: body.paths.map(p =>
          p === '/main.tex'
            ? docResponse(p, MAIN, body.startLine, body.endLine)
            : docResponse(p, 'one\ntwo', body.startLine, body.endLine)
        ),
        missing: [],
      }))
      const result = await server.call('read_file', {
        projectId: 'p1',
        paths: ['/main.tex', 'chapters/a.tex'],
      })
      expect(client.get.called).to.be.false
      expect(client.post.calledOnce).to.be.true
      expect(client.post.firstCall.args[1]).to.equal('/projects/p1/docs/read')
      expect(client.post.firstCall.args[2]).to.deep.equal({
        paths: ['/main.tex', '/chapters/a.tex'],
        startLine: 1,
        endLine: 500,
      })
      const data = envelope(result).data
      expect(data.documents.map(d => d.path)).to.deep.equal(['/main.tex', '/chapters/a.tex'])
      expect(data.documents[1].truncated).to.be.false
      expect(envelope(result).summary).to.equal('2 docs')
      expect(bodyOf(result)).to.equal(
        [
          '/main.tex  1-4/4',
          '1\t\\documentclass{article}',
          '2\t\\begin{document}',
          '3\tHi',
          '4\t\\end{document}',
          '',
          '/chapters/a.tex  1-2/2',
          '1\tone',
          '2\ttwo',
        ].join('\n')
      )
    })

    it('fails the batch with not_found for a missing document', async function () {
      client.post.resolves({
        documents: [docResponse('/main.tex', MAIN, 1, 4)],
        missing: [{ path: '/nope.tex', reason: 'not_found' }],
      })
      const result = await server.call('read_file', {
        projectId: 'p1',
        paths: ['/main.tex', '/nope.tex'],
      })
      expect(result.isError).to.be.true
      expect(envelope(result).error.code).to.equal('not_found')
      expect(envelope(result).error.hint).to.include('list_files')
    })

    it('fails the batch with validation_error for a binary document', async function () {
      client.post.resolves({
        documents: [],
        missing: [{ path: '/fig.png', reason: 'binary' }],
      })
      const result = await server.call('read_file', {
        projectId: 'p1',
        paths: ['/fig.png', '/main.tex'],
      })
      expect(envelope(result).error.code).to.equal('validation_error')
      expect(envelope(result).error.message).to.equal(
        '/fig.png is a binary file, not a text document'
      )
    })

    it('fails the batch with the first per-document error', async function () {
      client.post.resolves({
        documents: [
          { path: '/main.tex', totalLines: 4, error: 'startLine 900 is past the end (4 lines)' },
          docResponse('/chapters/a.tex', 'one\ntwo', 900, 900),
        ],
        missing: [],
      })
      const result = await server.call('read_file', {
        projectId: 'p1',
        paths: ['/main.tex', '/chapters/a.tex'],
        startLine: 900,
      })
      expect(result.isError).to.be.true
      expect(envelope(result).error.code).to.equal('validation_error')
    })

    it('refuses more documents in one read than the per-call limit', function () {
      const schema = server.tools.get('read_file').config.inputSchema
      const paths = Array.from({ length: 101 }, (_, i) => `/f${i}.tex`)
      expect(schema.safeParse({ projectId: 'p1', paths }).success).to.be.false
      expect(schema.safeParse({ projectId: 'p1', paths: paths.slice(0, 100) }).success).to.be.true
    })

    it('reads many documents in one batch request, in the order given', async function () {
      client.post.callsFake(async (token, path, body) => ({
        documents: body.paths.map(p => docResponse(p, 'x', body.startLine, body.endLine)),
        missing: [],
      }))
      const paths = Array.from({ length: 12 }, (_, i) => `/f${i}.tex`)
      const data = envelope(await server.call('read_file', { projectId: 'p1', paths })).data
      expect(data.documents.map(d => d.path)).to.deep.equal(paths)
      expect(client.post.callCount).to.equal(1)
      expect(client.get.called).to.be.false
    })

    it('refuses an end line before the start line without calling web', async function () {
      const result = await server.call('read_file', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 3,
        endLine: 2,
      })
      expect(result.isError).to.be.true
      expect(client.get.called).to.be.false
    })

    it('requires exactly one of path or paths', async function () {
      const neither = await server.call('read_file', { projectId: 'p1' })
      expect(neither.isError).to.be.true
      const both = await server.call('read_file', {
        projectId: 'p1',
        path: '/main.tex',
        paths: ['/main.tex'],
      })
      expect(both.isError).to.be.true
    })

    it('returns a default page of 500 lines when no endLine is given', async function () {
      client.get.resetBehavior()
      client.get.resolves(docResponse('/main.tex', 'x\n'.repeat(999), 1, 500))
      const result = await server.call('read_file', { projectId: 'p1', path: '/main.tex' })
      expect(client.get.firstCall.args[2].endLine).to.equal(500)
      expect(envelope(result).warnings).to.be.undefined
    })

    it('honours an endLine past 500 lines without a cap', async function () {
      client.get.resetBehavior()
      client.get.resolves(docResponse('/main.tex', 'x\n'.repeat(1999), 1, 1200))
      const result = await server.call('read_file', {
        projectId: 'p1',
        path: '/main.tex',
        endLine: 1200,
      })
      expect(client.get.firstCall.args[2].endLine).to.equal(1200)
      expect(envelope(result).warnings).to.be.undefined
    })

    it('reads a single document with the per-document GET, not the batch call', async function () {
      client.get.resetBehavior()
      client.get.resolves(docResponse('/x.tex', 'a\n', 1, 1))
      await server.call('read_file', { projectId: 'p1', path: '/x.tex', endLine: 1 })
      expect(client.get.callCount).to.equal(1)
      expect(client.post.called).to.be.false
    })
  })

  it('write_file posts the full content and reports whether it created the document', async function () {
    client.post.resolves({ status: 'ok', docId: 'd1', created: true, lineCount: 2 })
    const result = await server.call('write_file', {
      projectId: 'p1',
      path: 'main.tex',
      content: 'new\nbody',
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/doc')
    expect(client.post.firstCall.args[2]).to.deep.equal({
      path: '/main.tex',
      content: 'new\nbody',
    })
    expect(envelope(result).data).to.include({ path: '/main.tex', created: true, lineCount: 2 })
    expect(textOf(result)).to.equal('Created /main.tex (2 lines)')
  })

  it('write_file reports the line change when it replaces a document', async function () {
    client.post.resolves({ status: 'ok', created: false, lineCount: 120, previousLineCount: 300 })
    const result = await server.call('write_file', {
      projectId: 'p1',
      path: '/a.tex',
      content: 'x',
    })
    expect(textOf(result)).to.equal(
      'Replaced /a.tex: 300 -> 120 lines\n! /a.tex lost more than half its lines; if unintended, restore it from Overleaf History'
    )
  })

  it('write_file warns when an overwrite drops more than half of a long document', async function () {
    client.post.resolves({ status: 'ok', created: false, lineCount: 2, previousLineCount: 40 })
    const result = await server.call('write_file', {
      projectId: 'p1',
      path: '/main.tex',
      content: 'a\nb',
    })
    expect(envelope(result).warnings[0]).to.include('lost more than half')
  })

  describe('edit_file', function () {
    const DOC = 'alpha beta\ngamma beta\ndelta'

    beforeEach(function () {
      client.get.resolves({ path: '/main.tex', content: DOC })
      client.post.resolves({ status: 'ok', docId: 'd1' })
    })

    it('replaces one unique match and reports where it landed', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'gamma',
        newString: 'GAMMA',
      })
      expect(client.post.firstCall.args[2].content).to.equal(
        'alpha beta\nGAMMA beta\ndelta'
      )
      const data = envelope(result).data
      expect(data.replacements).to.equal(1)
      expect(data.changes).to.deep.equal([
        { editIndex: 0, startLine: 2, endLine: 2, diff: '- gamma\n+ GAMMA' },
      ])
      expect(bodyOf(result)).to.equal(
        '@@ 2-2\n1\talpha beta\n2\tGAMMA beta\n3\tdelta'
      )
      expect(textOf(result)).to.not.include('- gamma')
      expect(textOf(result)).to.not.include('"')
    })

    it('shows each changed region of several edits from the updated text', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        edits: [
          { oldString: 'alpha', newString: 'first\nalpha' },
          { oldString: 'delta', newString: 'DELTA' },
        ],
      })
      expect(bodyOf(result)).to.equal(
        [
          '@@ 1-2',
          '1\tfirst',
          '2\talpha beta',
          '3\tgamma beta',
          '4\tDELTA',
          '@@ 4-4',
          '2\talpha beta',
          '3\tgamma beta',
          '4\tDELTA',
        ].join('\n')
      )
    })

    it('shows the lines around a pure deletion', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: '\ngamma beta',
        newString: '',
      })
      expect(client.post.firstCall.args[2].content).to.equal('alpha beta\ndelta')
      expect(bodyOf(result)).to.equal('@@ deleted at 1\n1\talpha beta\n2\tdelta')
    })

    it('caps a long changed region at 60 lines and says how many were left out', async function () {
      const long = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join('\n')
      client.get.resolves({ path: '/main.tex', content: 'head\ntail' })
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'head',
        newString: long,
      })
      const text = textOf(result)
      expect(text).to.include('@@ 1-80')
      expect(text).to.include('… 21 more lines')
      expect(text).to.not.include('61\trow 61')
    })

    it('lists at most 20 changed regions and counts the rest', async function () {
      const doc = Array.from({ length: 30 }, () => 'hit').join('\n')
      client.get.resolves({ path: '/main.tex', content: doc })
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'hit',
        newString: 'miss',
        replaceAll: true,
      })
      const text = textOf(result)
      expect(text.split('\n').filter(line => line.startsWith('@@'))).to.have.length(20)
      expect(text).to.include('… 10 more changes not shown')
      expect(envelope(result).data.changes).to.have.length(30)
    })

    it('applies several edits in order and writes once', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        edits: [
          { oldString: 'alpha', newString: 'first\nalpha' },
          { oldString: 'delta', newString: 'DELTA' },
        ],
      })
      expect(client.post.calledOnce).to.be.true
      expect(client.post.firstCall.args[2].content).to.equal(
        'first\nalpha beta\ngamma beta\nDELTA'
      )
      expect(envelope(result).data.changes.map(c => c.startLine)).to.deep.equal([1, 4])
    })

    it('applies nothing when a later edit fails', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        edits: [
          { oldString: 'alpha', newString: 'ALPHA' },
          { oldString: 'not in the file', newString: 'x' },
        ],
      })
      expect(result.isError).to.be.true
      const error = envelope(result).error
      expect(error.code).to.equal('validation_error')
      expect(error.details.editIndex).to.equal(1)
      expect(client.post.called).to.be.false
    })

    it('returns the nearest text with its line numbers when nothing matches', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'gamma bata',
        newString: 'x',
      })
      const error = envelope(result).error
      expect(error.details.nearest.startLine).to.equal(2)
      expect(error.hint).to.include('lines 2-2')
      expect(client.post.called).to.be.false
    })

    it('lists the line of every match when the text is ambiguous', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'beta',
        newString: 'x',
      })
      const error = envelope(result).error
      expect(error.message).to.match(/2 places/)
      expect(error.details.matches.map(m => m.line)).to.deep.equal([1, 2])
      expect(client.post.called).to.be.false
    })

    it('changes every occurrence when replaceAll is set', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'beta',
        newString: 'B',
        replaceAll: true,
      })
      expect(client.post.firstCall.args[2].content).to.equal('alpha B\ngamma B\ndelta')
      expect(envelope(result).data.replacements).to.equal(2)
    })

    it('matches through whitespace drift and says it did', async function () {
      client.get.resolves({ path: '/main.tex', content: '  x  =\t1' })
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'x = 1',
        newString: 'x = 2',
      })
      expect(client.post.firstCall.args[2].content).to.equal('  x = 2')
      expect(envelope(result).warnings[0]).to.include('ignoring whitespace')
    })

    it('never reads a line-sliced document', async function () {
      await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        oldString: 'delta',
        newString: 'epsilon',
      })
      // A sliced read would truncate the write and destroy the rest of the file.
      expect(client.get.firstCall.args[2]).to.deep.equal({ path: '/main.tex' })
    })

    it('rejects edits combined with the single-edit shorthand', async function () {
      const result = await server.call('edit_file', {
        projectId: 'p1',
        path: '/main.tex',
        edits: [{ oldString: 'a', newString: 'b' }],
        oldString: 'a',
        newString: 'b',
      })
      expect(result.isError).to.be.true
      expect(client.post.called).to.be.false
    })
  })

  describe('edit_lines', function () {
    const DOC = 'one\ntwo\nthree\nfour'

    beforeEach(function () {
      client.get.resolves({ path: '/main.tex', content: DOC })
      client.post.resolves({ status: 'ok', docId: 'd1' })
    })

    it('replaces a line range and returns the removed lines', async function () {
      const result = await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 2,
        endLine: 3,
        newText: 'TWO\nTHREE\nTHREE-B',
      })
      expect(client.post.firstCall.args[2].content).to.equal(
        'one\nTWO\nTHREE\nTHREE-B\nfour'
      )
      const data = envelope(result).data
      expect(data.removedLines).to.deep.equal({ startLine: 2, endLine: 3, count: 2 })
      expect(data.insertedLines).to.equal(3)
      expect(data.totalLines).to.equal(5)
      expect(bodyOf(result)).to.equal(
        '@@ 2-4\n1\tone\n2\tTWO\n3\tTHREE\n4\tTHREE-B\n5\tfour'
      )
      expect(textOf(result)).to.not.include('two')
    })

    it('shows the lines around a deletion as "deleted at"', async function () {
      const result = await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 2,
        endLine: 2,
        newText: '',
      })
      expect(bodyOf(result)).to.equal('@@ deleted at 2\n1\tone\n2\tthree\n3\tfour')
      expect(textOf(result)).to.not.include('- two')
    })

    it('inserts before and after an anchor line without removing anything', async function () {
      await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 1,
        mode: 'insert_before',
        newText: 'zero',
      })
      expect(client.post.firstCall.args[2].content).to.equal('zero\none\ntwo\nthree\nfour')
      await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 4,
        mode: 'insert_after',
        newText: 'five',
      })
      expect(client.post.secondCall.args[2].content).to.equal(
        'one\ntwo\nthree\nfour\nfive'
      )
    })

    it('summarises an insert as inserted, not as a replacement', async function () {
      const result = await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 1,
        mode: 'insert_before',
        newText: 'zero',
      })
      expect(envelope(result).summary).to.equal('Inserted 1 line(s) at 1 in /main.tex')
    })

    it('deletes lines when newText is empty', async function () {
      await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 2,
        endLine: 2,
        newText: '',
      })
      expect(client.post.firstCall.args[2].content).to.equal('one\nthree\nfour')
    })

    it('reports the valid line count when startLine is past the end', async function () {
      const result = await server.call('edit_lines', {
        projectId: 'p1',
        path: '/main.tex',
        startLine: 9,
        newText: 'x',
      })
      expect(result.isError).to.be.true
      expect(envelope(result).error.details).to.deep.equal({ totalLines: 4 })
      expect(client.post.called).to.be.false
    })
  })

  it('move_file posts both normalised paths', async function () {
    client.post.resolves({ status: 'ok' })
    const result = await server.call('move_file', {
      projectId: 'p1',
      oldPath: 'a.tex',
      newPath: './chapters/b.tex',
    })
    expect(client.post.firstCall.args[2]).to.deep.equal({
      oldPath: '/a.tex',
      newPath: '/chapters/b.tex',
    })
    expect(envelope(result).data).to.deep.equal({ oldPath: '/a.tex', newPath: '/chapters/b.tex' })
    expect(textOf(result).split('\n')).to.deep.equal([
      'Moved /a.tex -> /chapters/b.tex',
      '→ scan_latex aspect=includes (references are not rewritten)',
    ])
  })

  it('delete_file sends a DELETE for the normalised path and reports the counts', async function () {
    client.request.resolves({ status: 'ok', deleted: { docs: 0, files: 2, folders: 1 } })
    const result = await server.call('delete_file', {
      projectId: 'p1',
      path: '\\figures\\old',
    })
    expect(client.request.firstCall.args.slice(1)).to.deep.equal([
      'DELETE',
      '/projects/p1/file',
      { query: { path: '/figures/old' } },
    ])
    expect(envelope(result).data.deleted).to.deep.equal({ docs: 0, files: 2, folders: 1 })
    expect(textOf(result)).to.include('Deleted /figures/old: 0 doc(s), 2 file(s), 1 folder(s)')
    expect(result.structuredContent.summary).to.include('Deleted /figures/old')
    expect(envelope(result).warnings[0]).to.include('restore_file')
  })

  it('delete_file refuses the project root without calling web', async function () {
    const result = await server.call('delete_file', { projectId: 'p1', path: '/' })
    expect(result.isError).to.be.true
    expect(client.request.called).to.be.false
  })

  it('upload_asset forwards base64 content', async function () {
    client.post.resolves({ status: 'ok', path: '/figures/a.png', fileId: 'f1' })
    const result = await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.png',
      contentBase64: 'AAAA',
    })
    expect(client.post.firstCall.args[1]).to.equal('/projects/p1/file')
    expect(client.post.firstCall.args[2].contentBase64).to.equal('AAAA')
    expect(envelope(result).data).to.deep.equal({ path: '/figures/a.png', fileId: 'f1' })
    expect(textOf(result)).to.equal('Stored /figures/a.png')
  })

  it('upload_asset forwards a url instead', async function () {
    client.post.resolves({ status: 'ok', fileId: 'f1' })
    await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.pdf',
      url: 'https://example.com/a.pdf',
    })
    expect(client.post.firstCall.args[2].url).to.equal('https://example.com/a.pdf')
  })

  it('accepts long queries, many edits and large match counts without a schema cap', function () {
    const schemaOf = name => server.tools.get(name).config.inputSchema
    expect(
      schemaOf('search_files').safeParse({
        projectId: 'p1',
        query: 'x'.repeat(1000),
        contextLines: 9,
        maxMatches: 1000,
      }).success
    ).to.be.true
    expect(
      schemaOf('edit_file').safeParse({
        projectId: 'p1',
        path: '/main.tex',
        edits: Array.from({ length: 51 }, () => ({ oldString: 'a', newString: 'b' })),
      }).success
    ).to.be.true
  })

  it('upload_asset forwards large base64 content without a local size cap', async function () {
    client.post.resolves({ path: '/figures/a.png', fileId: 'f1' })
    const big = 'A'.repeat(30 * 1024 * 1024)
    const result = await server.call('upload_asset', {
      projectId: 'p1',
      path: '/figures/a.png',
      contentBase64: big,
    })
    expect(result.isError).to.not.be.true
    expect(client.post.firstCall.args[2].contentBase64).to.have.lengthOf(big.length)
  })

  it('upload_asset requires exactly one of contentBase64 or url', async function () {
    const neither = await server.call('upload_asset', { projectId: 'p1', path: '/a.png' })
    expect(neither.isError).to.be.true
    const both = await server.call('upload_asset', {
      projectId: 'p1',
      path: '/a.png',
      contentBase64: 'AAAA',
      url: 'https://example.com/a.png',
    })
    expect(both.isError).to.be.true
    expect(client.post.called).to.be.false
  })

  it('download_file requests binary file and returns the envelope then the resource block', async function () {
    client.requestBinary.resolves({
      contentType: 'image/png',
      base64: Buffer.from('png-bytes').toString('base64'),
    })
    const result = await server.call('download_file', {
      projectId: 'p1',
      path: 'figures/plot.png',
    })
    expect(client.requestBinary.firstCall.args[0]).to.equal(TOKEN)
    expect(client.requestBinary.firstCall.args[1]).to.equal('/projects/p1/file')
    expect(client.requestBinary.firstCall.args[2]).to.deep.equal({
      path: '/figures/plot.png',
    })
    expect(result.content[0].type).to.equal('text')
    expect(envelope(result).data.mimeType).to.equal('image/png')
    expect(textOf(result)).to.equal('Downloaded /figures/plot.png (9 bytes, image/png)')
    expect(result.content[1].type).to.equal('resource')
    expect(result.content[1].resource.mimeType).to.equal('image/png')
    expect(result.content[1].resource.uri).to.include('/figures/plot.png')
  })

  describe('search_files', function () {
    it('passes the query, scope and options to web and returns its matches', async function () {
      client.get.resolves({
        query: 'theorem',
        regex: false,
        totalMatches: 1,
        truncated: false,
        filesSearched: 3,
        matches: [
          { path: '/intro.tex', line: 5, text: '\\begin{theorem}', before: [], after: [] },
        ],
      })
      const result = await server.call('search_files', {
        projectId: 'p1',
        query: 'theorem',
        path: 'chapters',
        glob: '*.tex',
        contextLines: 2,
        maxMatches: 15,
      })
      expect(client.get.firstCall.args[1]).to.equal('/projects/p1/search')
      expect(client.get.firstCall.args[2]).to.deep.equal({
        query: 'theorem',
        regex: false,
        caseSensitive: false,
        path: '/chapters',
        glob: '*.tex',
        contextLines: 2,
        maxMatches: 15,
      })
      const payload = envelope(result)
      expect(payload.data.matches[0]).to.include({ path: '/intro.tex', line: 5 })
      expect(payload.nextSteps).to.be.undefined
      expect(textOf(result)).to.equal('1 matches in 3 docs\n/intro.tex\n  5: \\begin{theorem}')
    })

    it('groups matches by file and prints context lines with their own numbers', async function () {
      client.get.resolves({
        query: 'hit',
        regex: false,
        totalMatches: 2,
        truncated: false,
        filesSearched: 2,
        matches: [
          { path: '/a.tex', line: 5, text: 'hit', before: ['x', 'y'], after: ['z'] },
          { path: '/b.tex', line: 1, text: 'hit again', before: [], after: [] },
        ],
      })
      const result = await server.call('search_files', { projectId: 'p1', query: 'hit' })
      expect(textOf(result).split('\n')).to.deep.equal([
        '2 matches in 2 docs',
        '/a.tex',
        '  3- x',
        '  4- y',
        '  5: hit',
        '  6- z',
        '/b.tex',
        '  1: hit again',
      ])
      expect(textOf(result)).to.not.include('"')
    })

    it('warns when results were cut off at maxMatches', async function () {
      client.get.resolves({
        query: 'x',
        regex: false,
        totalMatches: 2,
        truncated: true,
        filesSearched: 1,
        matches: [],
      })
      const result = await server.call('search_files', { projectId: 'p1', query: 'x' })
      expect(envelope(result).warnings[0]).to.include('maxMatches')
    })
  })
})
