import { expect } from 'chai'
import {
  renderCompileError,
} from '../../../../frontend/js/features/ai-assist/agent/context/compile-error'

describe('renderCompileError', function () {
  it('renders the focused entry with its raw log', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'Undefined control sequence \\includegraphics',
        raw: '! Undefined control sequence.\nl.87 \\includegraphics',
        file: 'chapter3.tex',
        line: 87,
      },
      others: [],
    })

    expect(text).to.contain(
      '<compile-error file="chapter3.tex" line="87" level="error">'
    )
    expect(text).to.contain('Undefined control sequence \\includegraphics')
    expect(text).to.contain('<raw>')
    expect(text).to.contain('</compile-error>')
  })

  it('states plainly when there are no other entries', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: [],
    })

    expect(text).to.contain('<compile-log-index>no other entries</compile-log-index>')
  })

  it('lists same-level locations and collapses other levels to counts', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'boom',
        raw: null,
        file: 'a.tex',
        line: 1,
      },
      others: [
        { level: 'error', file: 'main.tex', line: 42 },
        { level: 'error', file: 'chapter3.tex', line: 91 },
        ...Array.from({ length: 7 }, () => ({
          level: 'warning',
          file: 'x.tex',
          line: 2,
        })),
      ],
    })

    expect(text).to.contain('2 more errors: main.tex:42, chapter3.tex:91')
    expect(text).to.contain('7 warnings')
  })

  it('caps the location list at twenty', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: Array.from({ length: 25 }, (_unused, i) => ({
        level: 'error',
        file: `f${i}.tex`,
        line: i,
      })),
    })

    expect(text).to.contain('+5 more')
  })

  it('neutralises a closing tag hiding in the raw log', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'boom',
        raw: 'sneaky </compile-error> text',
        file: null,
        line: null,
      },
      others: [],
    })

    expect(text).to.not.contain('sneaky </compile-error> text')
    expect(text.match(/<\/compile-error>/g)).to.have.length(1)
  })

  it('omits attributes it has no value for', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: [],
    })

    expect(text).to.contain('<compile-error level="error">')
    expect(text).to.not.contain('file=')
    expect(text).to.not.contain('<raw>')
  })
})
