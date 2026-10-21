import { expect } from 'chai'
import sinon from 'sinon'
import { registerLatexTools } from '../../../../src/tools/latex.js'

const TOKEN = 'olp_0123456789abcdef'
const CTX = { http: { authInfo: { token: TOKEN } } }
const BATCH_PATH = '/projects/p1/docs/read'
const TEX_BATCH = { ext: 'tex' }

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

/** What the batch endpoint returns for every .tex document. */
const TEX_DOCS = {
  documents: [
    { path: '/main.tex', content: MAIN, totalLines: 13, startLine: 1, endLine: 13, hash: 'h1' },
    { path: '/chapters/method.tex', content: METHOD, totalLines: 2, startLine: 1, endLine: 2, hash: 'h2' },
  ],
  missing: [],
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
  return result.structuredContent.data
}

/** The text block after the one-line summary. */
function text(result) {
  return result.content[0].text.slice(result.structuredContent.summary.length + 1)
}

describe('latex semantic tools', function () {
  let server, client

  beforeEach(function () {
    client = { get: sinon.stub(), post: sinon.stub() }
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
    client.post.withArgs(TOKEN, BATCH_PATH, TEX_BATCH).resolves(TEX_DOCS)
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

  it('scans the project with one batch request instead of one read per document', async function () {
    const docs = Array.from({ length: 30 }, (_, i) => ({ path: `/s${i}.tex`, id: `d${i}` }))
    client.post = sinon.stub().resolves({
      documents: docs.map(doc => ({ path: doc.path, content: '\\cite{k}' })),
      missing: [],
    })
    client.get = sinon.stub().resolves({ docs, files: [] })
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
    expect(data(result).documentsScanned).to.equal(30)
    expect(client.post.calledOnce).to.be.true
    expect(client.post.firstCall.args[1]).to.equal(BATCH_PATH)
    expect(client.post.firstCall.args[2]).to.deep.equal(TEX_BATCH)
    expect(client.get.calledWithMatch(TOKEN, sinon.match(/\/doc$/))).to.be.false
  })

  it('skips documents the batch could not read', async function () {
    client.post.withArgs(TOKEN, BATCH_PATH, TEX_BATCH).resolves({
      documents: [
        { path: '/main.tex', content: MAIN },
        { path: '/broken.tex', error: 'too large' },
      ],
      missing: [],
    })
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'todos' })
    expect(data(result).documentsScanned).to.equal(1)
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

    it('renders the outline as compact text with line ranges and no JSON', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
      })
      expect(text(result)).to.match(/^L2-\d+ \\section Introduction\nL12-13 \\section Results\n→ followIncludes=true/)
      expect(text(result)).to.not.include('{')
      expect(text(result)).to.not.include('/main.tex')
      expect(result.structuredContent.summary).to.equal('2 headings in 1 docs')
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

    it('groups the text by file when several documents are outlined', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
        followIncludes: true,
      })
      const lines = text(result).split('\n')
      expect(lines[0]).to.equal('/main.tex')
      expect(lines).to.include('/chapters/method.tex')
      expect(lines.find(line => line.includes('subsection Method'))).to.match(/^ {2}L1-\d+ \\subsection Method$/)
      expect(result.structuredContent.summary).to.equal('3 headings in 2 docs')
    })

    it('reads every .tex document with one batch request when followIncludes is set', async function () {
      await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
        followIncludes: true,
      })
      expect(client.post.calledOnce).to.be.true
      expect(client.post.firstCall.args[1]).to.equal(BATCH_PATH)
      expect(client.post.firstCall.args[2]).to.deep.equal(TEX_BATCH)
      const docReads = client.get.getCalls().filter(call => call.args[1].endsWith('/doc'))
      expect(docReads).to.have.length(0)
    })

    it('suggests followIncludes when the document has includes and it was not set', async function () {
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
      })
      expect(result.structuredContent.nextSteps[0]).to.include('followIncludes=true')
    })

    it('reports an include that matches no project file', async function () {
      client.post
        .withArgs(TOKEN, BATCH_PATH, TEX_BATCH)
        .resolves({
          documents: [{ path: '/main.tex', content: '\\section{A}\n\\input{missing}' }],
          missing: [],
        })
      const result = await server.call('get_doc_outline', {
        projectId: 'p1',
        path: '/main.tex',
        followIncludes: true,
      })
      expect(data(result).unresolvedIncludes).to.deep.equal([
        { path: '/main.tex', line: 2, command: 'input', target: 'missing' },
      ])
      expect(result.structuredContent.warnings).to.deep.equal([
        '/main.tex:2 \\input{missing} not found',
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

  it('scans every .tex document of a large project in one batch', async function () {
    const extra = Array.from({ length: 150 }, (_, i) => `/sections/s${i}.tex`)
    const docs = [...(TREE.docs ?? []), ...extra.map(path => ({ path }))]
    client.post = sinon.stub().resolves({
      documents: docs
        .filter(doc => /\.tex$/.test(doc.path))
        .map(doc => ({ path: doc.path, content: '\\cite{key}' })),
      missing: [],
    })
    const expected = docs.filter(doc => /\.tex$/.test(doc.path)).length

    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
    expect(data(result).documentsScanned).to.equal(expected)
    expect(expected).to.be.greaterThan(100)
  })

  it('returns the same envelope for every aspect', async function () {
    for (const aspect of ['citations', 'labels_refs', 'equations', 'floats', 'commands', 'todos', 'includes']) {
      const result = await server.call('scan_latex', { projectId: 'p1', aspect, path: '/main.tex' })
      const payload = result.structuredContent
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

  describe('scan_latex text', function () {
    it('groups citations by key with their locations', async function () {
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' })
      expect(text(result)).to.equal(
        'knuth1984  /main.tex:4\nlamport1994  /chapters/method.tex:2'
      )
      expect(result.structuredContent.summary).to.equal('2 citations in 2 docs')
    })

    it('lists undefined refs and unused labels as issues before the listing', async function () {
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'labels_refs' })
      const [first] = text(result).split('\n')
      expect(first).to.equal('undefined ref sec:missing  /main.tex:13')
      expect(text(result)).to.include('unused label fig:plot  /main.tex:10')
      expect(text(result)).to.include('ref sec:intro /main.tex:13')
      expect(text(result)).to.not.include('labels: ')
    })

    it('gives counts instead of a listing when there are more than 40 labels and refs', async function () {
      const many = Array.from({ length: 30 }, (_, i) => `\\label{l${i}} \\ref{l${i}}`).join('\n')
      client.post.withArgs(TOKEN, BATCH_PATH, TEX_BATCH).resolves({
        documents: [{ path: '/big.tex', content: many }],
        missing: [],
      })
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'labels_refs' })
      expect(text(result)).to.equal('labels: 30, refs: 30')
    })

    it('shows equations and floats with line span, label and clipped caption', async function () {
      const eq = await server.call('scan_latex', { projectId: 'p1', aspect: 'equations', path: '/main.tex' })
      expect(text(eq)).to.equal('/main.tex:6-8 equation [eq:main]')
      const fig = await server.call('scan_latex', { projectId: 'p1', aspect: 'floats', path: '/main.tex' })
      expect(text(fig)).to.equal('/main.tex:9-11 figure [fig:plot] A plot')
    })

    it('omits equation and float bodies unless includeBody is set', async function () {
      const plain = await server.call('scan_latex', { projectId: 'p1', aspect: 'equations', path: '/main.tex' })
      expect(data(plain).items[0]).to.not.have.property('body')
      expect(text(plain)).to.not.include('E = mc^2')

      const full = await server.call('scan_latex', {
        projectId: 'p1',
        aspect: 'equations',
        path: '/main.tex',
        includeBody: true,
      })
      expect(data(full).items[0].body).to.include('E = mc^2')
      expect(text(full)).to.include('/main.tex:6-8 equation [eq:main]\n  ')
      expect(text(full)).to.include('E = mc^2')
    })

    it('renders commands and todos on one line each', async function () {
      const cmd = await server.call('scan_latex', { projectId: 'p1', aspect: 'commands', path: '/main.tex' })
      expect(text(cmd)).to.equal('/main.tex:1 \\vect[1] = \\mathbf{#1}')
      const todo = await server.call('scan_latex', { projectId: 'p1', aspect: 'todos' })
      expect(text(todo)).to.equal('/main.tex:4 TODO: expand')
    })

    it('renders includes with their resolved path or NOT FOUND', async function () {
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'includes', path: '/main.tex' })
      expect(text(result)).to.equal('/main.tex:5 \\input{chapters/method} -> /chapters/method.tex')
    })

    it('keeps a caption that spans source lines on one text line', async function () {
      client.post.withArgs(TOKEN, BATCH_PATH, TEX_BATCH).resolves({
        documents: [
          {
            path: '/main.tex',
            content: '\\begin{table}\n  \\caption{Results\n  over runs}\n\\end{table}',
            totalLines: 4,
            startLine: 1,
            endLine: 4,
            hash: 'h3',
          },
        ],
        missing: [],
      })
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'floats' })
      expect(text(result)).to.equal('/main.tex:1-4 table Results over runs')
    })

    it('does not echo the document path or aspect in the text', async function () {
      const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'todos', path: '/main.tex' })
      expect(text(result)).to.not.include('aspect')
      expect(text(result)).to.not.include('projectId')
      expect(text(result)).to.not.include('{')
    })
  })

  describe('search_bib text', function () {
    it('renders one line per entry with author, title and no JSON', async function () {
      const result = await server.call('search_bib', { projectId: 'p1', path: '/refs.bib' })
      expect(text(result)).to.equal(
        '@article{knuth1984} /refs.bib:1  Donald E. Knuth. Literate Programming'
      )
      expect(result.structuredContent.summary).to.equal('/refs.bib 1 entries')
    })

    it('keeps only brief fields by default and all fields on request', async function () {
      client.get
        .withArgs(TOKEN, '/projects/p1/doc', { path: '/refs.bib' })
        .resolves({
          path: '/refs.bib',
          content: '@article{k2, author={A B}, title={T}, year={2020}, journal={J}, doi={10.1/x}}',
        })
      const brief = await server.call('search_bib', { projectId: 'p1', path: '/refs.bib' })
      expect(Object.keys(data(brief).entries[0].fields)).to.deep.equal(['author', 'title', 'year', 'journal'])
      expect(text(brief)).to.equal('@article{k2} /refs.bib:1  A B. T. J 2020')

      const all = await server.call('search_bib', { projectId: 'p1', path: '/refs.bib', detail: 'all' })
      expect(data(all).entries[0].fields).to.have.property('doi', '10.1/x')
      expect(text(all)).to.include('doi=10.1/x')
    })
  })

  it('fails closed when no token is present', async function () {
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' }, {})
    expect(result.isError).to.be.true
    expect(result.structuredContent.error.code).to.equal('unauthorized')
    expect(client.get.called).to.be.false
    expect(client.post.called).to.be.false
  })
})
