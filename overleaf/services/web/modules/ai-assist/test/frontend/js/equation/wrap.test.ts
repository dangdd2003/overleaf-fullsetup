import { expect } from 'chai'
import { CursorWhere } from '../../../../frontend/js/features/ai-assist/equation/context'
import {
  hasTopLevel,
  joinAround,
  normalizeBody,
  resolveForm,
  uniqueLabel,
  wrapEquation,
} from '../../../../frontend/js/features/ai-assist/equation/wrap'

const prose: CursorWhere = { kind: 'text', container: 'text', from: 0, to: 100 }
const caption: CursorWhere = { kind: 'text', container: 'caption', from: 0, to: 100 }
const inMath: CursorWhere = { kind: 'math', math: 'display', from: 0, to: 100 }

describe('equation: wrap', function () {
  it('cleans a body: delimiters, environments, labels, blank lines, a trailing \\\\', function () {
    expect(normalizeBody('$x^2$')).to.deep.equal({ body: 'x^2', label: null })
    expect(normalizeBody('\\[\n  a = b\n\\]')).to.deep.equal({ body: 'a = b', label: null })
    expect(
      normalizeBody('\\begin{align}\na &= b \\\\\n\nc &= d \\\\\n\\label{eq:x}\n\\end{align}')
    ).to.deep.equal({ body: 'a &= b \\\\\nc &= d', label: 'eq:x' })
    expect(normalizeBody('$a$ and $b$').body).to.equal('$a$ and $b$')
  })

  it('finds \\\\ and & outside nested environments only', function () {
    expect(hasTopLevel('a \\\\ b', '\\\\')).to.equal(true)
    expect(hasTopLevel('f = \\begin{cases} 1 & x \\\\ 0 \\end{cases}', '\\\\')).to.equal(false)
    expect(hasTopLevel('f = \\begin{cases} 1 & x \\\\ 0 \\end{cases}', '&')).to.equal(false)
    expect(hasTopLevel('a &= b', '&')).to.equal(true)
  })

  it('keeps the form the model chose when it fits', function () {
    expect(resolveForm('equation', 'E = mc^2', prose)).to.deep.equal({ form: 'equation', coerced: false })
    expect(resolveForm('align', 'a &= b \\\\ c &= d', prose)).to.deep.equal({ form: 'align', coerced: false })
  })

  it('chooses a form when the model gave none', function () {
    expect(resolveForm(null, 'E = mc^2', prose).form).to.equal('display')
    expect(resolveForm(null, 'a &= b \\\\ c &= d', prose).form).to.equal('align')
  })

  it('fits the form to the body', function () {
    expect(resolveForm('equation', 'a &= b \\\\ c &= d', prose).form).to.equal('align')
    expect(resolveForm('display', 'a = b \\\\ c = d', prose).form).to.equal('gather*')
    expect(resolveForm('body', 'x', prose)).to.deep.equal({ form: 'display', coerced: false })
  })

  it('forces the body inside math and inline math in captions', function () {
    expect(resolveForm('equation', 'x', inMath)).to.deep.equal({ form: 'body', coerced: true })
    expect(resolveForm('body', 'x', inMath)).to.deep.equal({ form: 'body', coerced: false })
    expect(resolveForm('equation', 'x', caption)).to.deep.equal({ form: 'inline', coerced: true })
  })

  it('wraps each form', function () {
    const wrap = (form: any, body = 'x', label: string | null = null) =>
      wrapEquation({ form, body, label, indent: '', parenInline: false })
    expect(wrap('body')).to.equal('x')
    expect(wrap('inline')).to.equal('$x$')
    expect(wrapEquation({ form: 'inline', body: 'x', label: null, indent: '', parenInline: true })).to.equal('\\(x\\)')
    expect(wrap('display')).to.equal('\\[\n  x\n\\]')
    expect(wrap('equation', 'E = mc^2', 'eq:e')).to.equal(
      '\\begin{equation}\n  E = mc^2\n  \\label{eq:e}\n\\end{equation}'
    )
    expect(wrap('equation*', 'x', 'eq:dropped')).to.equal('\\begin{equation*}\n  x\n\\end{equation*}')
  })

  it('labels the first line of a numbered multi-line form', function () {
    expect(wrapEquation({ form: 'align', body: 'a &= b \\\\\nc &= d', label: 'eq:f', indent: '  ', parenInline: false })).to.equal(
      '  \\begin{align}\n    a &= b \\label{eq:f} \\\\\n    c &= d\n  \\end{align}'
    )
  })

  it('makes a label unique', function () {
    expect(uniqueLabel('eq:a', new Set(['eq:b']))).to.equal('eq:a')
    expect(uniqueLabel('eq:a', new Set(['eq:a', 'eq:a-2']))).to.equal('eq:a-3')
  })

  it('puts a block on its own lines without adding blank lines', function () {
    const block = '\\begin{equation}\n  x\n\\end{equation}'
    expect(joinAround('is given by ', block, ' where x is.', true)).to.equal(
      `is given by\n${block}\nwhere x is.`
    )
    expect(joinAround('is given by\n', block, '\nwhere x is.', true)).to.equal(
      `is given by\n${block}\nwhere x is.`
    )
    expect(joinAround('', block, '', true)).to.equal(block)
  })

  it('puts inline math in as is', function () {
    expect(joinAround('mass ', '$m$', ' here', false)).to.equal('mass $m$ here')
  })
})
