import { expect } from 'chai'
import {
  TOOLS,
  toolSpecs,
} from '../../../../frontend/js/features/ai-assist/agent/tools/registry'
import { MAX_READ_LINES } from '../../../../frontend/js/features/ai-assist/agent/project-handle'
import { readFileTool } from '../../../../frontend/js/features/ai-assist/agent/tools/read-file'
import {
  searchTextTool,
  matchesGlob,
} from '../../../../frontend/js/features/ai-assist/agent/tools/search-text'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}',
  'chapters/intro.tex': 'Intro text\nSecond line',
}

describe('read tools', function () {
  it('exposes every tool spec with a JSON-schema object', function () {
    const names = toolSpecs().map(spec => spec.name)
    expect(names).to.include.members(['list_files', 'read_file', 'search_text'])
    for (const spec of toolSpecs()) {
      expect(spec.parameters).to.have.property('type', 'object')
      expect(spec.description).to.be.a('string').and.not.be.empty
    }
  })

  it('read_file description clarifies line numbers are for display only', function () {
    expect(readFileTool.spec.description).to.include('Line numbers in the output')
    expect(readFileTool.spec.description).to.include('never include line number prefixes in oldText or newText')
  })

  it('list_files returns every path with its type', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      binaries: ['figures/plot.png'],
    })
    const result: any = await TOOLS.list_files.execute({}, handle)
    expect(result.files.map((file: any) => file.path)).to.deep.equal([
      'main.tex',
      'chapters/intro.tex',
      'figures/plot.png',
    ])
    expect(result.files.at(-1).type).to.equal('binary')
  })

  it('read_file numbers the lines it returns', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute(
      { path: 'chapters/intro.tex' },
      handle
    )
    expect(result.content).to.equal('1: Intro text\n2: Second line')
    expect(result.truncated).to.equal(false)
  })

  it('read_file honours a line range', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute(
      { path: 'main.tex', from: 2, to: 3 },
      handle
    )
    expect(result.content).to.equal('2: \\begin{document}\n3: Hello')
  })

  it('read_file refuses a binary file with a readable message', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      binaries: ['figures/plot.png'],
    })
    const result: any = await TOOLS.read_file.execute(
      { path: 'figures/plot.png' },
      handle
    )
    expect(result.error).to.match(/binary/i)
  })

  it('read_file reports a missing path instead of throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.read_file.execute({ path: 'nope.tex' }, handle)
    expect(result.error).to.match(/not found/i)
  })

  it('read_file truncates a file longer than the cap', async function () {
    const long = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n')
    const { handle } = createFakeHandle({ docs: { 'long.tex': long } })
    const result: any = await TOOLS.read_file.execute({ path: 'long.tex', from: 1 }, handle)
    expect(result.truncated).to.equal(true)
    expect(result.content.split('\n')).to.have.length(1000)
  })

  it('read_file reads at most 500 lines when no range is given', async function () {
    const text = Array.from({ length: 1200 }, (_, i) => `l${i + 1}`).join('\n')
    const { handle } = createFakeHandle({ docs: { 'long.tex': text } })

    const result: any = await readFileTool.execute({ path: 'long.tex' }, handle)

    expect(result.to).to.equal(500)
    expect(result.nextRange).to.deep.equal({ from: 501, to: 1000 })

    const ranged: any = await readFileTool.execute({ path: 'long.tex', from: 1, to: 1200 }, handle)
    expect(ranged.to).to.equal(1000)
  })

  it('search_text returns path, line and text', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await TOOLS.search_text.execute({ query: 'Intro' }, handle)
    expect(result.hits).to.deep.equal([
      {
        path: 'chapters/intro.tex',
        line: 1,
        text: 'Intro text',
        before: [],
        after: ['Second line'],
      },
    ])
  })

  it('search_text caps the number of hits it returns', async function () {
    const many = Array.from({ length: 200 }, () => 'needle').join('\n')
    const { handle } = createFakeHandle({ docs: { 'many.tex': many } })
    const result: any = await TOOLS.search_text.execute(
      { query: 'needle' },
      handle
    )
    expect(result.hits).to.have.length(50)
    expect(result.truncated).to.equal(true)
  })

  it('reports the total line count so the model can page', async function () {
    const lines = Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`)
    const { handle } = createFakeHandle({ docs: { 'main.tex': lines.join('\n') } })

    const result: any = await readFileTool.execute({ path: 'main.tex', from: 5, to: 8 }, handle)

    expect(result.totalLines).to.equal(20)
    expect(result.from).to.equal(5)
    expect(result.to).to.equal(8)
    expect(result.content).to.include('5: line 5')
    expect(result.content).to.include('8: line 8')
    expect(result.content).to.not.include('9: line 9')
  })

  it('names the next range to request when it truncates', async function () {
    const lines = Array.from({ length: MAX_READ_LINES + 50 }, (_unused, index) => `l${index}`)
    const { handle } = createFakeHandle({ docs: { 'big.tex': lines.join('\n') } })

    const result: any = await readFileTool.execute({ path: 'big.tex', from: 1 }, handle)

    expect(result.truncated).to.equal(true)
    expect(result.nextRange).to.deep.equal({
      from: MAX_READ_LINES + 1,
      to: MAX_READ_LINES + 50,
    })
  })

  it('has no next range once the end of the file is reached', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const result: any = await readFileTool.execute({ path: 'main.tex' }, handle)

    expect(result.truncated).to.equal(false)
    expect(result.nextRange).to.equal(undefined)
  })

  it('clamps a range that runs past the end of the file', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const result: any = await readFileTool.execute({ path: 'main.tex', from: 2, to: 99 }, handle)

    expect(result.to).to.equal(3)
    expect(result.content).to.include('3: c')
  })

  it('filters hits by a glob', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': 'needle here',
        'sections/one.tex': 'needle here too',
        'refs.bib': 'needle in bib',
      },
    })

    const result: any = await searchTextTool.execute(
      { query: 'needle', glob: 'sections/*.tex' },
      handle
    )

    expect(result.hits.map((hit: any) => hit.path)).to.deep.equal(['sections/one.tex'])
  })

  it('accepts path parameter as alias for glob', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': 'needle here',
        'sections/one.tex': 'needle here too',
      },
    })

    const result: any = await searchTextTool.execute(
      { query: 'needle', path: 'sections/one.tex' },
      handle
    )

    expect(result.hits.map((hit: any) => hit.path)).to.deep.equal(['sections/one.tex'])
  })

  it('finds matches in targeted file even when another file contains 60+ matches', async function () {
    const many = Array.from({ length: 70 }, () => 'needle').join('\n')
    const { handle } = createFakeHandle({
      docs: {
        'noisy.tex': many,
        'target.tex': 'needle in target',
      },
    })

    const result: any = await searchTextTool.execute(
      { query: 'needle', glob: 'target.tex' },
      handle
    )

    expect(result.hits.map((hit: any) => hit.path)).to.deep.equal(['target.tex'])
  })

  it('matches globs with and without directory crossing', function () {
    expect(matchesGlob('a/b/c.tex', '**/*.tex')).to.equal(true)
    expect(matchesGlob('a/b/c.bib', '**/*.tex')).to.equal(false)
    expect(matchesGlob('main.tex', '**/*.tex')).to.equal(true)
    expect(matchesGlob('main.tex', '*.tex')).to.equal(true)
    expect(matchesGlob('a/main.tex', '*.tex')).to.equal(false)
    expect(matchesGlob('sections/one.tex', 'sections/*.tex')).to.equal(true)
  })

  it('returns surrounding context lines', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'before\nneedle\nafter' },
    })

    const result: any = await searchTextTool.execute(
      { query: 'needle', contextLines: 1 },
      handle
    )

    expect(result.hits[0].before).to.deep.equal(['before'])
    expect(result.hits[0].after).to.deep.equal(['after'])
  })

  it('reports the true total when it truncates', async function () {
    const many = Array.from({ length: 80 }, () => 'needle').join('\n')
    const { handle } = createFakeHandle({ docs: { 'main.tex': many } })

    const result: any = await searchTextTool.execute({ query: 'needle' }, handle)

    expect(result.truncated).to.equal(true)
    expect(result.total).to.equal(80)
    expect(result.hits.length).to.be.lessThan(80)
  })

  describe('the read tools share one parameter vocabulary', function () {
    it('search_text takes a glob or path', function () {
      const props = (searchTextTool.spec.parameters as any).properties
      expect(props).to.have.property('glob')
      expect(props).to.have.property('path')
    })

    it('read_file takes an exact path and line numbers only', function () {
      const props = (readFileTool.spec.parameters as any).properties
      expect(Object.keys(props).sort()).to.deep.equal(['from', 'path', 'to'])
      expect(props).to.not.have.property('section')
    })

    it('search_text still narrows by pattern under the new name', async function () {
      const { handle } = createFakeHandle({
        docs: { 'main.tex': 'needle', 'sections/a.tex': 'needle' },
      })
      const result: any = await searchTextTool.execute(
        { query: 'needle', glob: 'sections/*.tex' },
        handle
      )
      expect(result.hits.map((m: any) => m.path)).to.deep.equal([
        'sections/a.tex',
      ])
    })
  })

  it('search_text renders context lines in file order', function () {
    expect(
      searchTextTool.render!({
        hits: [{ path: 'main.tex', line: 5, text: 'hit', before: ['b1', 'b2'], after: ['a1'] }],
        total: 1,
        truncated: false,
      })
    ).to.equal('Found 1 hit(s):\n  3: b1\n  4: b2\nmain.tex:5: hit\n  6: a1')
  })
})
