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

function payload(result) {
  return JSON.parse(result.content[0].text)
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

  it('get_doc_outline lists the sections of one document', async function () {
    const result = await server.call('get_doc_outline', {
      projectId: 'p1',
      path: '/main.tex',
    })
    expect(payload(result).outline.map(s => s.title)).to.deep.equal([
      'Introduction',
      'Results',
    ])
  })

  it('get_doc_outline gives every section a line range that read_file can slice', async function () {
    const result = await server.call('get_doc_outline', {
      projectId: 'p1',
      path: '/main.tex',
    })
    const [intro, results] = payload(result).outline
    // The range must stop before the next same-level heading, so that slicing
    // main.tex on it yields the Introduction body and nothing after it.
    expect(intro.endLine).to.equal(results.startLine - 1)
    const body = MAIN.split('\n').slice(intro.startLine - 1, intro.endLine).join('\n')
    expect(body).to.include('\\cite{knuth1984}')
    expect(body).to.not.include('\\section{Results}')
  })

  it('scan_latex with aspect: includes resolves an \\input to a project document', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'includes',
      path: '/main.tex',
    })
    const [child] = payload(result).includes
    expect(child.path).to.equal('chapters/method')
    expect(child.resolvedPath).to.equal('/chapters/method.tex')
  })

  it('scan_latex with aspect: citations scans every tex document by default', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'citations',
    })
    expect(payload(result).citations.map(c => c.key)).to.have.members([
      'knuth1984',
      'lamport1994',
    ])
  })

  it('scan_latex with aspect: citations can be limited to one document', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'citations',
      path: '/main.tex',
    })
    expect(payload(result).citations.map(c => c.key)).to.deep.equal(['knuth1984'])
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
    expect(payload(result).entries[0].key).to.equal('knuth1984')
  })

  it('search_bib filters entries when query is provided', async function () {
    const result = await server.call('search_bib', {
      projectId: 'p1',
      path: '/refs.bib',
      query: 'literate',
    })
    expect(payload(result).entries).to.have.length(1)
  })

  it('scan_latex with aspect: labels_refs flags references with no matching label', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'labels_refs',
    })
    expect(payload(result).undefinedRefs).to.include('sec:missing')
  })

  it('scan_latex with aspect: labels_refs flags labels nothing references', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'labels_refs',
    })
    expect(payload(result).unusedLabels).to.include('fig:plot')
  })

  it('scan_latex with aspect: equations finds equation environments with their labels', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'equations',
      path: '/main.tex',
    })
    expect(payload(result).equations[0].label).to.equal('eq:main')
  })

  it('scan_latex with aspect: floats returns captions', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'floats',
      path: '/main.tex',
    })
    expect(payload(result).floats[0].caption).to.equal('A plot')
  })

  it('scan_latex with aspect: commands returns the definitions', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'commands',
      path: '/main.tex',
    })
    expect(payload(result).commands[0].name).to.equal('\\vect')
  })

  it('scan_latex with aspect: todos returns notes with their file and line', async function () {
    const result = await server.call('scan_latex', {
      projectId: 'p1',
      aspect: 'todos',
    })
    const [note] = payload(result).notes
    expect(note.text).to.equal('expand')
    expect(note.path).to.equal('/main.tex')
    expect(note.line).to.equal(4)
  })

  it('fails closed when no token is present', async function () {
    const result = await server.call('scan_latex', { projectId: 'p1', aspect: 'citations' }, {})
    expect(result.isError).to.be.true
    expect(payload(result).code).to.equal('unauthorized')
    expect(client.get.called).to.be.false
  })
})
