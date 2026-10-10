import { expect } from 'chai'
import {
  completionFacts,
  completionWindow,
  PREFIX_CHARS,
  SUFFIX_CHARS,
} from '../../../../frontend/js/features/ai-assist/completion/context'

const LINE = 'x'.repeat(99) + '\n' // 100 characters

describe('completion: context', function () {
  it('takes the whole document when it is short', function () {
    expect(completionWindow('Our method works.', 4)).to.deep.equal({
      prefix: 'Our ',
      suffix: 'method works.',
      atStart: true,
    })
  })

  it('cuts the prefix at a line start and the suffix at a line end', function () {
    const doc = LINE.repeat(60) + 'Our method' + '\n' + LINE.repeat(30)
    const pos = LINE.length * 60 + 'Our method'.length
    const { prefix, suffix, atStart } = completionWindow(doc, pos)
    expect(atStart).to.equal(false)
    expect(prefix.length).to.be.at.most(PREFIX_CHARS)
    expect(prefix.endsWith('Our method')).to.equal(true)
    expect(doc[pos - prefix.length - 1]).to.equal('\n')
    expect(suffix.length).to.be.at.most(SUFFIX_CHARS)
    expect(doc[pos + suffix.length]).to.equal('\n')
  })

  it('collects what the model should know about the document', function () {
    const doc = [
      '\\documentclass{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{amsmath, graphicx}',
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\title{Fast  Solvers}',
      '\\begin{document}',
      '\\section{Introduction}\\label{sec:intro}',
      'See \\cite{knuth, lamport} and \\citep[p.~2]{doe}.',
      '% \\section{Hidden} \\label{hidden}',
      '\\section{Method}',
      '\\subsection{Training}',
      '\\begin{itemize}',
      '\\item We',
    ].join('\n')
    const facts = completionFacts(doc, doc.length)
    expect(facts).to.deep.include({
      docClass: 'article',
      packages: ['inputenc', 'amsmath', 'graphicx'],
      macros: ['\\R'],
      title: 'Fast Solvers',
      outline: ['Introduction', 'Method', 'Training'],
      section: 'Method / Training',
      envs: ['itemize'],
      labels: ['sec:intro'],
      cites: ['knuth', 'lamport', 'doe'],
    })
  })

  it('reads the abstract, which says what the document is about', function () {
    const doc = '\\begin{document}\n\\begin{abstract}\n  We study  fast solvers. % draft\n\\end{abstract}\nBody'
    expect(completionFacts(doc, doc.length).abstract).to.equal('We study fast solvers.')
    expect(completionFacts('\\abstract{Short one.}\nBody', 20).abstract).to.equal('Short one.')
    expect(completionFacts('Body', 2)).to.not.have.property('abstract')
  })

  it('has empty lists for a bare document', function () {
    expect(completionFacts('Just text', 4)).to.deep.include({
      docClass: null,
      packages: [],
      outline: [],
      section: '',
      envs: [],
      labels: [],
      cites: [],
    })
  })
  it('starts the prefix at a paragraph when one starts near the edge of the window', function () {
    const doc = LINE.repeat(20) + '\n' + LINE.repeat(25) + 'Our method'
    const pos = doc.length
    const { prefix } = completionWindow(doc, pos)
    expect(prefix.startsWith('x')).to.equal(true)
    expect(doc.slice(pos - prefix.length - 2, pos - prefix.length)).to.equal('\n\n')
  })

  it('keeps the labels nearest the cursor when there are too many', function () {
    const labels = Array.from({ length: 60 }, (_, i) => `\\label{l${i}}`).join('\n')
    const facts = completionFacts(labels, labels.length)
    expect(facts.labels).to.have.length(40)
    expect(facts.labels).to.include('l59')
    expect(facts.labels).to.not.include('l0')
  })
})
