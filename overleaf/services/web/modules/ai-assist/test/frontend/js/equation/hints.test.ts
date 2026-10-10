import { expect } from 'chai'
import {
  DEFAULT_LABEL_STYLE,
  equationHabits,
  labelsIn,
  labelStyle,
  prefersParenInline,
} from '../../../../frontend/js/features/ai-assist/equation/hints'

describe('equation: hints', function () {
  it('takes the most common equation-label prefix', function () {
    expect(labelStyle(['eqn:a', 'eqn:b', 'eq:c', 'fig:d', 'sec:e'])).to.equal('eqn:')
    expect(labelStyle(['equation:x'])).to.equal('equation:')
    expect(labelStyle(['fig:a', 'tab:b'])).to.equal(DEFAULT_LABEL_STYLE)
  })

  it('reads labels outside comments', function () {
    expect([...labelsIn('\\label{eq:a} % \\label{eq:old}\n\\label{ sec:b }')]).to.deep.equal([
      'eq:a',
      'sec:b',
    ])
  })

  it('counts the equation forms the document uses', function () {
    const doc = [
      '\\begin{equation}a\\end{equation}',
      '\\begin{equation}b\\end{equation}',
      '\\begin{align*}c\\end{align*}',
      '\\[ d \\]',
      '$$ e $$',
      '% \\begin{gather} commented \\end{gather}',
    ].join('\n')
    expect(equationHabits(doc)).to.equal('equation:2 align*:1 \\[:1 $$:1')
    expect(equationHabits('No math.')).to.equal('')
  })

  it('prefers \\( \\) only when the document uses it more than $', function () {
    expect(prefersParenInline('\\(a\\) and \\(b\\) and $c$')).to.equal(true)
    expect(prefersParenInline('$a$ and $b$ and \\(c\\)')).to.equal(false)
    expect(prefersParenInline('$$x$$ and \\(y\\)')).to.equal(true)
  })
})
