import { expect } from 'chai'
import { selectionShape } from '../../../../frontend/js/features/ai-assist/writing-tools/selection-shape'
import {
  availableActions,
  menuNotice,
  SelectionShape,
} from '../../../../frontend/js/features/ai-assist/writing-tools/actions'

describe('writing tools: selection shape', function () {
  it('counts words and one sentence', function () {
    expect(selectionShape('Hello world')).to.deep.equal({
      words: 2,
      sentences: 1,
      longestSentence: 2,
      joinable: 0,
      hasLetters: true,
      chars: 11,
    })
  })

  it('treats a hard-wrapped sentence as one sentence', function () {
    const shape = selectionShape('This sentence is\nwrapped over\nthree lines.')
    expect(shape.sentences).to.equal(1)
    expect(shape.words).to.equal(7)
  })

  it('counts sentences and the longest one', function () {
    const shape = selectionShape('One two. Three four five.')
    expect(shape.words).to.equal(5)
    expect(shape.sentences).to.equal(2)
    expect(shape.longestSentence).to.equal(3)
  })

  it('treats a blank line as a sentence break', function () {
    expect(selectionShape('Heading text\n\nBody text here').sentences).to.equal(
      2
    )
  })

  it('does not count math, citation keys, command names or comments', function () {
    expect(
      selectionShape('We use $\\alpha + \\beta$ as in \\cite{smith20, doe21}.')
        .words
    ).to.equal(4)
    expect(selectionShape('\\textbf{Bold} claim \\emph{here}.').words).to.equal(
      3
    )
    expect(selectionShape('Visible words % hidden words here').words).to.equal(2)
    expect(selectionShape('50\\% of cases').words).to.equal(3)
  })

  it('finds no words in pure math', function () {
    expect(selectionShape('$x^2 + y^2$').words).to.equal(0)
  })

  it('finds no letters in numbers alone', function () {
    expect(selectionShape('2024').hasLetters).to.equal(false)
  })

  it('counts short neighbouring sentences as joinable', function () {
    expect(
      selectionShape('We train it. It is fast. It is also small.').joinable
    ).to.equal(2)
  })

  it('never joins across paragraphs, list items or environments', function () {
    expect(selectionShape('We train it.\n\nIt is fast.').joinable).to.equal(0)
    expect(
      selectionShape('\\item We train it.\n\\item It is fast.').joinable
    ).to.equal(0)
    expect(
      selectionShape('We train it.\n\\end{abstract}\nIt is fast.').joinable
    ).to.equal(0)
  })

  it('does not join two long sentences', function () {
    const long = 'word '.repeat(20).trim()
    expect(selectionShape(`${long}. ${long}.`).joinable).to.equal(0)
  })
})


function shape(overrides: Partial<SelectionShape>): SelectionShape {
  return {
    words: 12,
    sentences: 1,
    longestSentence: 12,
    joinable: 0,
    hasLetters: true,
    chars: 80,
    ...overrides,
  }
}

describe('writing tools: available actions', function () {
  it('offers nothing without a selection, prose, or within the size limit', function () {
    expect(menuNotice(shape({ chars: 0, words: 0 }))).to.equal('empty')
    expect(menuNotice(shape({ words: 0 }))).to.equal('noProse')
    expect(menuNotice(shape({ words: 1, hasLetters: false }))).to.equal(
      'noProse'
    )
    expect(menuNotice(shape({ chars: 9000 }))).to.equal('tooLong')
    expect(availableActions(shape({ chars: 9000 }))).to.deep.equal([])
    expect(menuNotice(shape({}))).to.equal(null)
  })

  it('offers Synonyms and Translate for one word', function () {
    expect(
      availableActions(shape({ words: 1, longestSentence: 1 }))
    ).to.deep.equal(['synonyms', 'translate'])
  })

  it('leads with Synonyms for a short phrase', function () {
    expect(
      availableActions(shape({ words: 3, longestSentence: 3 }))
    ).to.deep.equal(['synonyms', 'rephrase', 'scientific', 'translate'])
  })

  it('treats several short sentences as sentences, not a phrase', function () {
    expect(
      availableActions(
        shape({ words: 4, sentences: 2, longestSentence: 2, joinable: 1 })
      )
    ).to.deep.equal(['rephrase', 'scientific', 'join', 'translate'])
  })

  it('offers Shorten only from ten words', function () {
    expect(
      availableActions(shape({ words: 7, longestSentence: 7 }))
    ).to.deep.equal(['rephrase', 'scientific', 'translate'])
    expect(availableActions(shape({}))).to.deep.equal([
      'rephrase',
      'shorten',
      'scientific',
      'translate',
    ])
  })

  it('offers Split for a long sentence', function () {
    expect(
      availableActions(shape({ words: 30, longestSentence: 30 }))
    ).to.deep.equal(['rephrase', 'shorten', 'scientific', 'split', 'translate'])
  })

  it('offers Join only for joinable sentences, and both when one is long', function () {
    expect(
      availableActions(shape({ words: 40, sentences: 2, longestSentence: 20 }))
    ).to.deep.equal(['rephrase', 'shorten', 'scientific', 'translate'])
    expect(
      availableActions(
        shape({ words: 40, sentences: 3, longestSentence: 30, joinable: 1 })
      )
    ).to.deep.equal([
      'rephrase',
      'shorten',
      'scientific',
      'split',
      'join',
      'translate',
    ])
  })

  it('never splits or joins a heading', function () {
    expect(
      availableActions(
        shape({ words: 30, sentences: 2, longestSentence: 26, joinable: 1 }),
        'heading'
      )
    ).to.deep.equal(['rephrase', 'shorten', 'scientific', 'translate'])
  })
})
