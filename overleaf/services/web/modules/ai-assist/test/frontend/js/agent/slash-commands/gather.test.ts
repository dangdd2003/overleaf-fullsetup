import { expect } from 'chai'
import { gatherSlashContext } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/gather'
import { slashCommandById } from '../../../../../frontend/js/features/ai-assist/agent/slash-commands/catalog'
import { createFakeHandle } from '../helpers/fake-handle'
import type { LastCompile } from '../../../../../frontend/js/features/ai-assist/agent/project-handle'

const SECTIONED = [
  '\\section{Intro}',
  'Hello.',
  '',
  '\\section{Method}',
  'We do X.',
  'More text.',
  '',
  '\\section{Results}',
  'Done.',
].join('\n')

const PREAMBLE_DOC = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  'Body.',
  '\\end{document}',
].join('\n')

function command(id: Parameters<typeof slashCommandById>[0]) {
  const definition = slashCommandById(id)
  if (!definition) throw new Error(`no command ${id}`)
  return definition
}

const FAILED_COMPILE: LastCompile = {
  status: 'failure',
  errors: [
    {
      message: 'Undefined control sequence.',
      file: 'main.tex',
      line: 3,
      excerpt: '! Undefined control sequence.\nl.3 \\foo',
    },
  ],
  warnings: [],
  rawLog: null,
}

describe('gatherSlashContext', function () {
  it('renders one block per gatherer that found something, in the command order', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': PREAMBLE_DOC },
      lastCompile: FAILED_COMPILE,
    })
    const blocks = await gatherSlashContext({
      handle,
      command: command('fix'),
      selection: null,
    })
    expect(blocks).to.have.length(2)
    expect(blocks[0]).to.match(/^<compile-errors>/)
    expect(blocks[1]).to.match(/^<preamble /)
  })

  it('omits the compile log when the last compile has no entries', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': PREAMBLE_DOC },
      lastCompile: { status: 'success', errors: [], warnings: [], rawLog: null },
    })
    const blocks = await gatherSlashContext({
      handle,
      command: command('fix'),
      selection: null,
    })
    expect(blocks).to.have.length(1)
    expect(blocks[0]).to.match(/^<preamble /)
    expect(blocks.join('\n')).not.to.include('<compile-errors>')
  })

  it('reads the source around a compile error and marks its line', async function () {
    const doc = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const { handle } = createFakeHandle({
      docs: { 'main.tex': doc },
      lastCompile: FAILED_COMPILE,
    })
    const [log] = await gatherSlashContext({
      handle,
      command: command('fix'),
      selection: null,
    })
    expect(log).to.include('<compile-error file="main.tex" line="3" level="error">')
    expect(log).to.include('<source file="main.tex" lines="1-9" entry-line="3">')
    expect(log).to.include('3: line 3')
    expect(log).to.include('1 in all: main.tex:3')
  })

  it('caps the compile entries and says how many were left out', async function () {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      message: `error ${i}`,
      file: 'main.tex',
      line: i + 1,
    }))
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x\n'.repeat(20) },
      lastCompile: { status: 'failure', errors, warnings: [], rawLog: null },
    })
    const [log] = await gatherSlashContext({
      handle,
      command: command('fix'),
      selection: null,
    })
    expect(log.match(/<compile-error /g)).to.have.length(6)
    expect(log).to.include('(2 more errors not shown; get_compile_result lists them all)')
  })

  it('leaves warnings to /layout and only counts them', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': PREAMBLE_DOC },
      lastCompile: {
        ...FAILED_COMPILE,
        warnings: [{ message: 'Overfull \\hbox (3.2pt too wide)', file: 'main.tex', line: 4 }],
      },
    })
    const [log] = await gatherSlashContext({
      handle,
      command: command('fix'),
      selection: null,
    })
    expect(log).not.to.include('Overfull')
    expect(log).to.include('(1 warnings not shown)\n</compile-errors>')
  })

  it('gathers only box, float and page warnings for /layout', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': PREAMBLE_DOC },
      lastCompile: {
        status: 'success',
        errors: [],
        warnings: [
          { message: 'Overfull \\hbox (12.0pt too wide) in paragraph', file: 'main.tex', line: 4 },
          { message: "Reference `sec:x' undefined", file: 'main.tex', line: 2 },
          { message: "`h' float specifier changed to `ht'.", file: 'main.tex', line: 3 },
        ],
        rawLog: null,
      },
    })
    const [warnings] = await gatherSlashContext({
      handle,
      command: command('layout'),
      selection: null,
    })
    expect(warnings).to.match(/^<layout-warnings>/)
    expect(warnings).to.include('2 in all: main.tex:4, main.tex:3')
    expect(warnings).to.include('Overfull')
    expect(warnings).to.include('float specifier changed')
    expect(warnings).not.to.include('undefined')
  })

  it('renders the root document preamble, cut at \\begin{document}', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': PREAMBLE_DOC } })
    const [preamble] = await gatherSlashContext({
      handle,
      command: command('preamble'),
      selection: null,
    })
    expect(preamble).to.include('<preamble file="main.tex" lines="1-3">')
    expect(preamble).to.include('2: \\usepackage{graphicx}')
    expect(preamble).not.to.include('Body.')
  })

  it('gathers the section around the cursor, with the cursor line marked', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': SECTIONED },
      openFile: { path: 'main.tex', cursorLine: 5 },
    })
    const [section] = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: null,
    })
    expect(section).to.include('<section path="main.tex" lines="4-7" entry-line="5">')
    expect(section).to.include('4: \\section{Method}')
    expect(section).to.include('6: More text.')
    expect(section).not.to.include('Intro')
    expect(section).not.to.include('Results')
  })

  it('gathers the section around a selection, using the selection start', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': SECTIONED },
      selection: { path: 'main.tex', from: 2, to: 2, text: 'Hello.' },
    })
    const [section] = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: { path: 'main.tex', from: 2, to: 2, text: 'Hello.' },
    })
    expect(section).to.include('<section path="main.tex" lines="1-3" entry-line="2">')
  })

  it('skips the section when the selection already covers all of it', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': SECTIONED } })
    const blocks = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: { path: 'main.tex', from: 4, to: 7, text: 'the method' },
    })
    expect(blocks.join('\n')).not.to.include('<section ')
  })

  it('falls back to the window around the cursor in a file with no heading', async function () {
    const doc = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const { handle } = createFakeHandle({
      docs: { 'main.tex': doc },
      openFile: { path: 'main.tex', cursorLine: 15 },
    })
    const [window] = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: null,
    })
    expect(window).to.include('<source file="main.tex" lines="7-21" entry-line="15">')
  })

  it('gives insert commands the lines around the cursor', async function () {
    const doc = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const { handle } = createFakeHandle({
      docs: { 'main.tex': doc },
      openFile: { path: 'main.tex', cursorLine: 10 },
    })
    const [window] = await gatherSlashContext({
      handle,
      command: command('table'),
      selection: null,
    })
    expect(window).to.include('<source file="main.tex" lines="2-16" entry-line="10">')
    expect(window).to.include('10: line 10')
  })

  it('lists the outline with each section\'s line range', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': ['\\documentclass{article}', '\\begin{document}', SECTIONED, '\\end{document}'].join('\n') },
    })
    const [outline] = await gatherSlashContext({
      handle,
      command: command('review'),
      selection: null,
    })
    expect(outline).to.match(/^<outline>/)
    expect(outline).to.include('documentclass: article')
    expect(outline).to.include('main.tex:3-5 Intro')
    expect(outline).to.include('main.tex:6-9 Method')
    expect(outline).to.include('main.tex:10-12 Results')
  })

  it('lists macro definitions with their file and line', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\newcommand{\\vect}[1]{\\mathbf{#1}} % vectors\n',
        'macros.sty': '\\DeclareMathOperator{\\argmin}{arg\\,min}\n% \\newcommand{\\old}{x}\n',
      },
    })
    const blocks = await gatherSlashContext({
      handle,
      command: command('explain'),
      selection: null,
    })
    const macros = blocks.find(block => block.startsWith('<macros>'))
    expect(macros).to.include('main.tex:2: \\newcommand{\\vect}[1]{\\mathbf{#1}}')
    expect(macros).to.include('macros.sty:1: \\DeclareMathOperator{\\argmin}')
    expect(macros).not.to.include('\\old')
    expect(macros).not.to.include('vectors')
  })

  it('gathers nothing for the section when there is no cursor and no selection', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': SECTIONED } })
    const blocks = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: null,
    })
    expect(blocks).to.deep.equal([])
  })

  it('cuts a long section at the cap and says where it stops', async function () {
    const doc = ['\\section{Long}', ...Array.from({ length: 200 }, () => 'text')].join('\n')
    const { handle } = createFakeHandle({
      docs: { 'main.tex': doc },
      openFile: { path: 'main.tex', cursorLine: 2 },
    })
    const [section] = await gatherSlashContext({
      handle,
      command: command('rewrite'),
      selection: null,
    })
    expect(section).to.include('lines="1-120"')
    expect(section).to.include('(section continues past line 120; read_file for the rest)')
  })

  it('lists citation keys, which are cited, and which cited keys are missing', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\cite{smith2020} and \\citep{missing2021}.\n',
        'refs.bib': '@article{smith2020,\n  title={A}\n}\n@book{jones1999,\n  title={B}\n}\n',
      },
    })
    const [bib] = await gatherSlashContext({
      handle,
      command: command('cite'),
      selection: null,
    })
    expect(bib).to.match(/^<bib-keys>/)
    expect(bib).to.include('smith2020  refs.bib:1  cited 1x')
    expect(bib).to.include('jones1999  refs.bib:4  uncited')
    expect(bib).to.include('cited but not defined: missing2021')
  })

  it('reports labels, undefined references and unused labels', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\section{A}\\label{sec:a}\nSee \\ref{sec:a} and \\ref{sec:b}.\n\\label{fig:lonely}\n',
      },
    })
    const [labels] = await gatherSlashContext({
      handle,
      command: command('check'),
      selection: null,
    })
    expect(labels).to.match(/^<labels>/)
    expect(labels).to.include('defined (2): sec:a, fig:lonely')
    expect(labels).to.include('2 references, 1 undefined, 1 unused')
    expect(labels).to.include('\\ref{sec:b} main.tex:2')
    expect(labels).to.include('unused: fig:lonely')
  })

  it('reports the packages and the document class', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n' },
    })
    const [packages] = await gatherSlashContext({
      handle,
      command: command('translate'),
      selection: null,
    })
    expect(packages).to.match(/^<packages>/)
    expect(packages).to.include('documentclass: article')
    expect(packages).to.include('graphicx  (main.tex:2)')
  })

  it('gives nothing when every gatherer fails, and never throws', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': SECTIONED } })
    const broken = {
      ...handle,
      index: async () => {
        throw new Error('snapshot unavailable')
      },
      readFile: async () => {
        throw new Error('no file')
      },
      listFiles: async () => {
        throw new Error('no list')
      },
      rootDocPath: () => {
        throw new Error('no root')
      },
      lastCompile: () => {
        throw new Error('no log')
      },
    }
    const blocks = await gatherSlashContext({
      handle: broken as typeof handle,
      command: command('check'),
      selection: null,
    })
    expect(blocks).to.deep.equal([])
  })

  it('gives the same blocks for the same project state', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': PREAMBLE_DOC },
      lastCompile: FAILED_COMPILE,
      openFile: { path: 'main.tex', cursorLine: 1 },
    })
    const first = await gatherSlashContext({ handle, command: command('fix'), selection: null })
    const second = await gatherSlashContext({ handle, command: command('fix'), selection: null })
    expect(second).to.deep.equal(first)
  })
})
