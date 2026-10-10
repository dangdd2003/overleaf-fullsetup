import { expect } from 'chai'
import { buildUnits } from '../../../../frontend/js/features/ai-assist/language-suggestions/units'

const ENGLISH =
  'We trained the model on three datasets and report the results in this section. ' +
  'The method is fast and it is simple to use for all of the tasks.'
const GERMAN =
  'Wir haben das Modell auf drei Datensätzen trainiert und berichten hier die Ergebnisse. ' +
  'Die Methode ist schnell und einfach für alle Aufgaben zu verwenden, sagen die Autoren.'

const texts = (doc: string) => buildUnits(doc).map(unit => unit.masked.text)

describe('language suggestions: text left out', function () {
  it('leaves out what is between % ai-check-off and % ai-check-on', function () {
    const doc = `${ENGLISH}\n\n% ai-check-off\nThis sentence is never sent at all.\n% ai-check-on\n\nThis sentence is sent as usual.`
    expect(texts(doc)).to.include('This sentence is sent as usual.')
    expect(texts(doc)).to.not.include('This sentence is never sent at all.')
    // Off to the end of the file when never switched back on
    expect(texts(`${ENGLISH}\n\n%ai-check-off\n\nNot sent either, to the end.`)).to.not.include(
      'Not sent either, to the end.'
    )
  })

  it('leaves out a paragraph in another language in an English document', function () {
    const doc = `${ENGLISH}\n\n${GERMAN}`
    expect(texts(doc).some(text => text.startsWith('Wir haben'))).to.equal(false)
    expect(texts(doc).some(text => text.startsWith('We trained'))).to.equal(true)
  })

  it('never filters a document in another language, or one that reads as one', function () {
    const declared = `\\documentclass{article}\\usepackage[ngerman]{babel}\\begin{document}\n${GERMAN}\n\n${ENGLISH}\\end{document}`
    expect(texts(declared).some(text => text.startsWith('Wir haben'))).to.equal(true)
    // A chapter file with no preamble, in German throughout
    expect(texts(`${GERMAN}\n\n${GERMAN}`)).to.have.length.greaterThan(0)
  })
})
