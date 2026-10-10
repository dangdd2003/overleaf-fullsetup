import { expect } from 'chai'
import {
  blockReplacement,
  findExisting,
  generatorTask,
  newBlock,
  newKeywordsBlock,
} from '../../../../frontend/js/features/ai-assist/texgpt/generators'

const slice = (text: string, block: { from: number; to: number }) =>
  text.slice(block.from, block.to)

describe('texgpt: generators', function () {
  it('finds an existing title inside its braces, keeping a short title', function () {
    const text = '\\title[Short]{  Old title }'
    const block = findExisting('title', text, null)!
    expect(slice(text, block)).to.equal('Old title')
    expect(block.pad).to.equal(false)
    expect(blockReplacement('title', 'New', block)).to.equal('New')
  })

  it('finds an abstract and pads a replacement for an empty one', function () {
    const text = '\\begin{abstract}\n  Old.\n\\end{abstract}'
    expect(slice(text, findExisting('abstract', text, null)!)).to.equal('Old.')
    const empty = findExisting(
      'abstract',
      '\\begin{abstract}\n\\end{abstract}',
      null
    )!
    expect(empty.pad).to.equal(true)
    expect(blockReplacement('abstract', 'New.', empty)).to.equal('\nNew.\n')
  })

  it('finds keyword lists in every form and keeps their separator', function () {
    const ieee = '\\begin{IEEEkeywords}\nA, B\n\\end{IEEEkeywords}'
    expect(findExisting('keywords', ieee, 'IEEEtran')).to.include({
      separator: ', ',
    })
    const els = '\\begin{keyword}\nA \\sep B\n\\end{keyword}'
    const elsBlock = findExisting('keywords', els, 'elsarticle')!
    expect(slice(els, elsBlock)).to.equal('A \\sep B')
    expect(blockReplacement('keywords', ['x', 'y'], elsBlock)).to.equal(
      'x \\sep y'
    )
    expect(findExisting('keywords', '\\keywords{}', 'llncs')).to.include({
      separator: ' \\and ',
    })
    const bold = 'Intro\n\\noindent\\textbf{Keywords:} a, b\nNext'
    expect(slice(bold, findExisting('keywords', bold, 'article')!)).to.equal(
      'a, b'
    )
  })

  it('ignores commented and defined-only keywords and titles', function () {
    const text =
      '% \\title{Old}\n\\newcommand{\\keywords}[1]{#1}\n\\begin{document}'
    expect(findExisting('title', text, null)).to.equal(null)
    expect(findExisting('keywords', text, null)).to.equal(null)
  })

  it('writes a new keyword block in the convention of the class', function () {
    expect(newKeywordsBlock(['a', 'b'], 'IEEEtran')).to.equal(
      '\\begin{IEEEkeywords}\na, b\n\\end{IEEEkeywords}'
    )
    expect(newKeywordsBlock(['a', 'b'], 'elsarticle')).to.equal(
      '\\begin{keyword}\na \\sep b\n\\end{keyword}'
    )
    expect(newKeywordsBlock(['a', 'b'], 'llncs')).to.equal('\\keywords{a \\and b}')
    expect(newKeywordsBlock(['a', 'b'], 'acmart')).to.equal('\\keywords{a, b}')
    expect(newKeywordsBlock(['a', 'b'], 'article')).to.equal(
      '\\noindent\\textbf{Keywords:} a, b'
    )
  })

  it('writes new title and abstract blocks', function () {
    expect(newBlock('title', 'T', null)).to.equal('\\title{T}')
    expect(newBlock('abstract', ' Body. ', null)).to.equal(
      '\\begin{abstract}\nBody.\n\\end{abstract}'
    )
    expect(newBlock('keywords', 'a, b', 'llncs')).to.equal('\\keywords{a \\and b}')
  })

  it('asks for the right reply format', function () {
    expect(generatorTask('title')).to.include('<titles><t>')
    expect(generatorTask('abstract')).to.include('<latex>')
    expect(generatorTask('keywords')).to.include('<keywords><k>')
  })

  it('asks for titles that differ in style and an abstract from the body of the paper', function () {
    expect(generatorTask('title')).to.include('real alternatives')
    expect(generatorTask('abstract')).to.include('not on an abstract it may already have')
  })
})
