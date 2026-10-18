import { expect } from 'chai'
import sinon from 'sinon'
import { registerLatexTools } from '../../../../src/tools/latex.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }

const MAIN = [
  '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
  '\\section{Introduction}',
  '\\label{sec:intro}',
  'Prior work \\cite{knuth1984}. % TODO: expand',
  '\\input{chapters/method}',
  '\\begin{equation}',
  '  E = mc^2 \\label{eq:main}',
  '\\end{equation}',
  '\\begin{figure}',
  '  \\caption{A plot}\\label{fig:plot}',
  '\\end{figure}',
  '\\section{Results}',
  'See \\ref{sec:intro} and \\ref{sec:missing}.',
].join('\n')

const METHOD = '\\subsection{Method}\nWe cite \\cite{lamport1994}.'
const BIB = '@article{knuth1984,\n author = {Donald E. Knuth},\n title = {Literate Programming}\n}'

const TREE = {
  docs: [
    { path: '/main.tex', id: 'd1' },
    { path: '/chapters/method.tex', id: 'd2' },
    { path: '/refs.bib', id: 'd3' },
  ],
  files: [{ path: '/figures/plot.png', id: 'f1' }],
}

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

/** The data half of the shared success envelope. */
function data(result) {
  return JSON.parse(result.content[0].text).data
}

describe('latex semantic tools', function () {
  let server, client

  beforeEach(function () {
    client = { get: sinon.stub() }
    client.get.withArgs(TOKEN, '/projects/p1/tree').resolves(TREE)
    client.get
      .withArgs(TOKEN, '/projects/p1/doc', { path: '/main.tex' })
      .resolves({ path: '/main.tex', content: MAIN })
    client.get
      .withArgs(TOKEN, '/projects/p1/doc', { path: '/chapters/method.tex' })
      .resolves({ path: '/chapters/method.tex', content: METHOD })
    client.get
      .withArgs(TOKEN, '/projects/p1/doc', { path: '/refs.bib' })
      .resolves({ path: '/refs.bib', content: BIB })
    server = fakeServer()
    registerLatexTools(server, { client, staticToken: '' })
  })

  it('registers the three semantic tools', function () {
    expect([...server.tools.keys()]).to.have.members([
      'get_doc_outline',
      'scan_latex',
      'search_bib',
    ])
  })

  it('scans a large project a few documents at a time', async function () {
    const docs = Array.from({ length: 30 }, (_, i) => ({ path: `/s${i}.tex`, id: `d${i}` }))
    let inFlight = 0
    let peak = 0
    client.get = sinon.stub().callsFake(async (token, path, query) => {
      if (path === '/projects/p1/tree') return { docs, files: [] }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return { path: query.path, content: '\\cite{k}' }
    })
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
    expect(data(result).documentsScanned).to.equal(30)
    expect(peak).to.be.above(1).and.at.most(8)
  })

  describe('get_doc_outline', function () {
    it('lists the sections of one document with its path', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
      })
      expect(data(result).outline.map(s => s.title)).to.deep.equal([
        'Introduction',
        'Results',
      ])
      expect(data(result).outline[0].path).to.equal('/main.tex')
    })

    it('gives every section a line range that read_file can slice', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
      })
      const [intro, results] = data(result).outline
      // The range must stop before the next same-level heading, so that slicing
      // main.tex on it yields the Introduction body and nothing after it.
      expect(intro.endLine).to.equal(results.startLine - 1)
      const body = MAIN.split('\n').slice(intro.startLine - 1, intro.endLine).join('\n')
      expect(body).to.include('\\cite{knuth1984}')
      expect(body).to.not.include('\\section{Results}')
    })

    it('walks \\input into the chapter files when followIncludes is set', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
        followIncludes: true,
      })
      const payload = data(result)
      expect(payload.documents).to.deep.equal(['/main.tex', '/chapters/method.tex'])
      expect(payload.outline.map(s => [s.path, s.title])).to.deep.equal([
        ['/main.tex', 'Introduction'],
        ['/chapters/method.tex', 'Method'],
        ['/main.tex', 'Results'],
      ])
    })

    it('suggests followIncludes when the document has includes and it was not set', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
      })
      expect(JSON.parse(result.content[0].text).nextSteps[0]).to.include('followIncludes: true')
    })

    it('reports an include that matches no project file', async function () {
      client.get
        .withArgs(TOKEN, '/projects/p1/doc', { path: '/main.tex' })
        .resolves({ path: '/main.tex', content: '\\section{A}\n\\input{missing}' })
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
        followIncludes: true,
      })
      expect(data(result).unresolvedIncludes).to.deep.equal([
        { path: '/main.tex', line: 2, target: 'missing' },
      ])
    })
  })

  it('scan_latex with aspect: includes resolves an \\input to a project document', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'includes',
      path: '/main.tex',
    })
    const [child] = data(result).items
    expect(child).to.include({
      path: '/main.tex',
      line: 5,
      command: 'input',
      target: 'chapters/method',
      resolvedPath: '/chapters/method.tex',
    })
  })

  it('scan_latex with aspect: citations scans every tex document by default', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'citations',
    })
    expect(data(result).items.map(c => c.key)).to.have.members([
      'knuth1984',
      'lamport1994',
    ])
    expect(data(result).documentsScanned).to.equal(2)
  })

  it('scan_latex with aspect: citations can be limited to one document', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'citations',
      path: '/main.tex',
    })
    expect(data(result).items.map(c => c.key)).to.deep.equal(['knuth1984'])
  })

  it('scan_latex with aspect: citations never reads a .bib file as LaTeX', async function () {
    await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
    const paths = client.get.getCalls().map(call => call.args[2]?.path).filter(Boolean)
    expect(paths).to.not.include('/refs.bib')
  })

  it('search_bib parses a .bib document without query', async function () {
    const result = await server.call('search_bib', {
      projectId: 'p1',
      path: '/refs.bib',
    })
    expect(data(result).entries[0]).to.include({
      path: '/refs.bib',
      line: 1,
      key: 'knuth1984',
    })
    expect(data(result).total).to.equal(1)
  })

  it('search_bib filters entries when query is provided', async function () {
    const result = await server.call('search_bib', {
      projectId: 'p1',
      path: '/refs.bib',
      query: 'literate',
    })
    expect(data(result).entries).to.have.length(1)
    expect(data(result).matched).to.equal(1)
  })

  it('scan_latex with aspect: labels_refs flags references with no matching label', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'labels_refs',
    })
    const undefinedRef = data(result).issues.find(i => i.kind === 'undefined_ref')
    expect(undefinedRef).to.include({ name: 'sec:missing', path: '/main.tex', line: 13 })
  })

  it('scan_latex with aspect: labels_refs flags labels nothing references', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'labels_refs',
    })
    const unused = data(result).issues.filter(i => i.kind === 'unused_label')
    expect(unused.map(i => i.name)).to.include('fig:plot')
    expect(unused.find(i => i.name === 'fig:plot').path).to.equal('/main.tex')
  })

  it('scan_latex with aspect: equations finds equation environments with their labels', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'equations',
      path: '/main.tex',
    })
    expect(data(result).items[0]).to.include({
      path: '/main.tex',
      name: 'equation',
      label: 'eq:main',
      line: 6,
      endLine: 8,
    })
  })

  it('scan_latex with aspect: floats returns captions', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'floats',
      path: '/main.tex',
    })
    expect(data(result).items[0].caption).to.equal('A plot')
  })

  it('scan_latex with aspect: commands returns the definitions', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'commands',
      path: '/main.tex',
    })
    expect(data(result).items[0]).to.include({ name: '\\vect', arity: 1, line: 1 })
  })

  it('scan_latex with aspect: todos returns notes with their file and line', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'todos',
    })
    const [note] = data(result).items
    expect(note.text).to.equal('expand')
    expect(note.path).to.equal('/main.tex')
    expect(note.line).to.equal(4)
  })

  it('scans every .tex document in a large project without a document cap', async function () {
    const extra = Array.from({ length: 150 }, (_, i) => `/sections/s${i}.tex`)
    const docs = [...(TREE.docs ?? []), ...extra.map(path => ({ path }))]
    client.get.resetBehavior()
    client.get.callsFake(async (token, path, query) => {
      if (path === '/projects/p1/tree') return { ...TREE, docs }
      return { path: query.path, content: '\\cite{key}' }
    })
    const expected = docs.filter(doc => /\.tex$/.test(doc.path)).length

    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
    expect(data(result).documentsScanned).to.equal(expected)
    expect(expected).to.be.greaterThan(100)
  })

  it('returns the same envelope for every aspect', async function () {
    for (const aspect of ['citations', 'labels_refs', 'equations', 'floats', 'commands', 'todos', 'includes']) {
      const payload = JSON.parse(
        (await server.call('scan_latex', { projectId: 'p1', aspect, path: '/main.tex' })).content[0].text
      )
      expect(payload).to.include({ ok: true })
      expect(payload.data).to.include({ aspect })
      expect(payload.data).to.not.have.property('truncated')
      expect(payload.data.items).to.be.an('array')
      payload.data.items.forEach(item => {
        expect(item.path, `${aspect} item path`).to.be.a('string')
        expect(item.line, `${aspect} item line`).to.be.a('number')
      })
    }
  })

  it('fails closed when no token is present', async function () {
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' }, {})
    expect(result.isError).to.be.true
    expect(JSON.parse(result.content[0].text).error.code).to.equal('unauthorized')
    expect(client.get.called).to.be.false
  })
})
