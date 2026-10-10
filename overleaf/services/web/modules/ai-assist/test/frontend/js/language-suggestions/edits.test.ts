import { expect } from 'chai'
import {
  diffEdits,
  displayEdit,
  editIsSafe,
  editsForCheck,
  isMarkEdit,
  editsForRewrite,
  normaliseRewrite,
  sourceChange,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/edits'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

function unitOf(doc: string) {
  const [unit] = buildUnits(doc)
  return unit.masked
}

/** The document after applying every edit the checks kept. */
function applied(doc: string, rewrite: string): string {
  const masked = unitOf(doc)
  const edits = editsForRewrite(masked, rewrite)
  if (!edits) throw new Error('sentence dropped')
  let result = doc
  for (const edit of [...edits].reverse()) {
    const change = sourceChange(masked, edit)
    result = result.slice(0, change.from) + change.insert + result.slice(change.to)
  }
  return result
}

describe('language suggestions: edits', function () {
  it('writes typographic characters the way LaTeX source does', function () {
    expect(normaliseRewrite('  “Fast”  — and don’t stop – ok ')).to.equal(
      "``Fast'' --- and don't stop -- ok"
    )
  })

  it('turns a rewrite into word edits, merging neighbours one space apart', function () {
    expect(diffEdits('a big red car', 'a large blue car')).to.deep.equal([
      { from: 2, to: 9, original: 'big red', insert: 'large blue' },
    ])
  })

  it('keeps the placeholders out of every edit', function () {
    const doc = 'The results shows that the accuracy improve when $k$ is larger then $n$ \\cite{a}.'
    const masked = unitOf(doc)
    const edits = editsForRewrite(
      masked,
      'The results show that the accuracy improves when [[M1]] is larger than [[M2]] [[C1]].'
    )!
    expect(edits.map(e => [e.original, e.insert])).to.deep.equal([
      ['shows', 'show'],
      ['improve', 'improves'],
      ['then', 'than'],
    ])
    for (const edit of edits) {
      const change = sourceChange(masked, edit)
      expect(doc.slice(change.from, change.to)).to.equal(edit.original)
    }
  })

  it('drops the whole sentence when a placeholder is lost or most words change', function () {
    const masked = unitOf(
      'The results shows that the accuracy improve when $k$ is larger then $n$ \\cite{a}.'
    )
    expect(
      editsForRewrite(masked, 'The results show that the accuracy improves when [[M1]] is larger than [[M2]].')
    ).to.equal(null)
    expect(
      editsForRewrite(masked, 'Our findings demonstrate accuracy gains whenever [[M1]] exceeds [[M2]] [[C1]].')
    ).to.equal(null)
  })

  it('has nothing to suggest for an unchanged or empty rewrite', function () {
    const masked = unitOf('The method is fast and simple.')
    expect(editsForRewrite(masked, ' The method is fast and  simple. ')).to.deep.equal([])
    expect(editsForRewrite(masked, '')).to.deep.equal([])
  })

  it('drops an edit that would cut through hidden formatting', function () {
    const masked = unitOf('We study \\emph{very} large models in depth.')
    expect(editsForRewrite(masked, 'We study huge models in depth.')).to.deep.equal([])
  })

  it('keeps an edit inside a formatted word inside its braces', function () {
    expect(
      applied('We study \\emph{very} large models in depth.', 'We study really large models in depth.')
    ).to.equal('We study \\emph{really} large models in depth.')
  })

  it('never edits a protected space', function () {
    const masked = unitOf('As shown in Fig.~\\ref{f} the gain is clear.')
    const at = masked.text.indexOf('Fig. ')
    expect(
      editIsSafe(masked, { from: at, to: at + 5, original: 'Fig. ', insert: 'Figure ' })
    ).to.equal(false)
    expect(
      applied('As shown in Fig.~\\ref{f} the gain is clear.', 'As shown in Figure [[R1]] the gain is clear.')
    ).to.equal('As shown in Figure~\\ref{f} the gain is clear.')
  })

  it('drops edits that only change quotes, and LaTeX the model wrote', function () {
    const masked = unitOf("He said ``fine'' to us all today.")
    expect(editsForRewrite(masked, 'He said "fine" to us all today.')).to.deep.equal([])
    expect(editsForRewrite(masked, 'He said “fine” to us all today.')).to.deep.equal([])
    expect(
      editIsSafe(masked, { from: 0, to: 2, original: 'He', insert: '\\textbf{He}' })
    ).to.equal(false)
  })

  it('writes special characters back escaped', function () {
    expect(
      applied('Costs fell by 50\\% in R\\&D last year.', 'Costs fell by 50% in R&D & sales last year.')
    ).to.equal('Costs fell by 50\\% in R\\&D \\& sales last year.')
  })

  it('puts punctuation after a formatted word, and a new word before it', function () {
    expect(
      applied('We use \\emph{this} however it fails here.', 'We use this, however it fails here.')
    ).to.equal('We use \\emph{this}, however it fails here.')
    expect(
      applied('We use \\emph{fast} models in all tests.', 'We use very fast models in all tests.')
    ).to.equal('We use very \\emph{fast} models in all tests.')
  })

  it('keeps a line break the edit covers', function () {
    expect(
      applied('We study the\nproblem in depth today.', 'We study this issue in depth today.')
    ).to.equal('We study this\nissue in depth today.')
  })

  it('shifts the change by how far the sentence moved', function () {
    const masked = unitOf('The method is fast and simple.')
    const [edit] = editsForRewrite(masked, 'The method is quick and simple.')!
    expect(sourceChange(masked, edit, 5).from).to.equal(sourceChange(masked, edit).from + 5)
  })

  describe('punctuation shown with its word', function () {
    const masked = unitOf('First we test it (quickly) here.')
    const at = (word: string) => masked.text.indexOf(word)

    it('tells punctuation edits from word edits', function () {
      expect(isMarkEdit({ from: 5, to: 5, original: '', insert: ',' })).to.equal(true)
      expect(isMarkEdit({ from: 0, to: 1, original: '!', insert: '...' })).to.equal(true)
      expect(isMarkEdit({ from: 0, to: 5, original: 'First', insert: 'First,' })).to.equal(false)
      expect(isMarkEdit({ from: 5, to: 6, original: ' ', insert: '  ' })).to.equal(false)
    })

    it('grows an inserted comma back over the word before', function () {
      const edit = { from: at(' we'), to: at(' we'), original: '', insert: ',' }
      expect(displayEdit(masked, edit)).to.deep.equal({
        from: 0,
        to: at(' we'),
        original: 'First',
        insert: 'First,',
      })
    })

    it('grows a removed mark, and an opening one forward over the word after', function () {
      const close = at(') here')
      expect(displayEdit(masked, { from: close, to: close + 1, original: ')', insert: '' })).to.deep.equal({
        from: at('quickly'),
        to: close + 1,
        original: 'quickly)',
        insert: 'quickly',
      })
      const open = at('(')
      expect(displayEdit(masked, { from: open, to: open + 1, original: '(', insert: '' })).to.deep.equal({
        from: open,
        to: at(') here'),
        original: '(quickly',
        insert: 'quickly',
      })
    })

    it('stops at a neighbouring edit, and leaves word edits alone', function () {
      const edit = { from: at(' we'), to: at(' we'), original: '', insert: ',' }
      expect(displayEdit(masked, edit, at(' we'))).to.equal(edit)
      const word = { from: 0, to: 5, original: 'First', insert: 'Firstly' }
      expect(displayEdit(masked, word)).to.equal(word)
    })
  })
  it('keeps a spacing fix the reader sees, with the mark it sits next to', function () {
    const doc = 'Who is the person who takes responsibility ?\n'
    const masked = unitOf(doc)
    const edits = editsForRewrite(masked, 'Who is the person who takes responsibility?')!
    expect(edits).to.have.length(1)
    expect(edits[0]).to.include({ original: ' ?', insert: '?' })
    expect(isMarkEdit(edits[0])).to.equal(true)
    expect(applied(doc, 'Who is the person who takes responsibility?')).to.equal(
      'Who is the person who takes responsibility?\n'
    )
    expect(applied('We use it,then we stop here.\n', 'We use it, then we stop here.')).to.equal(
      'We use it, then we stop here.\n'
    )
  })

  it('shows a reworded phrase with the mark its dropped space was before', function () {
    const masked = unitOf('Who is the person who takes responsibility ?\n')
    const [edit] = editsForRewrite(masked, 'Who is the person responsible?')!
    expect(edit).to.include({ original: 'who takes responsibility ?', insert: 'responsible?' })
  })

  it('still drops spacing nobody sees', function () {
    expect(editsForRewrite(unitOf('We use  the model here.\n'), 'We use the model here.')).to.deep.equal([])
  })
  describe('a correction and a rewording', function () {
    const SENTENCE = 'In order to evaluate the model we uses a lot of load cases.\n'

    it('marks corrections grammar and the rest of the rewording style', function () {
      const masked = unitOf(SENTENCE)
      const edits = editsForCheck(masked, {
        grammar: 'In order to evaluate the model, we use a lot of load cases.',
        style: 'To evaluate the model, we use many load cases.',
      })!
      expect(edits.map(e => [e.kind, e.original, e.insert])).to.deep.equal([
        ['style', 'In order to ', 'To '],
        ['grammar', '', ','],
        ['grammar', 'uses', 'use'],
        // Holds the correction of "uses": shown once that is settled
        ['style', 'uses a lot of ', 'use many '],
      ])
    })

    it('splits a rewording from the correction it repeats', function () {
      const masked = unitOf('The results shows a big gain.\n')
      const edits = editsForCheck(masked, {
        grammar: 'The results show a big gain.',
        style: 'These results show a substantial gain.',
      })!
      expect(edits.map(e => [e.kind, e.original, e.insert])).to.deep.equal([
        ['style', 'The', 'These'],
        ['grammar', 'shows', 'show'],
        ['style', 'big', 'substantial'],
      ])
    })

    it('takes only the correction when style is not asked for, and nothing from an unusable reply', function () {
      const masked = unitOf(SENTENCE)
      expect(editsForCheck(masked, { grammar: 'In order to evaluate the model, we use a lot of load cases.' })!.every(e => e.kind === 'grammar')).to.equal(true)
      expect(editsForCheck(masked, { grammar: 'Something else entirely, written anew here.' })).to.equal(null)
    })
  })
})
