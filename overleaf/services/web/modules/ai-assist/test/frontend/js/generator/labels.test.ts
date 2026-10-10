import { expect } from 'chai'
import {
  labelsIn,
  labelStyle,
  uniqueLabel,
} from '../../../../frontend/js/features/ai-assist/generator/labels'

const TABLE_PREFIXES = ['table:', 'tab:']

describe('generator: labels', function () {
  it('picks the most used prefix, or the fallback', function () {
    expect(labelStyle(['tab:a', 'tab:b', 'table:c'], TABLE_PREFIXES, 'tab:')).to.equal('tab:')
    expect(labelStyle(['table:a', 'table:b', 'tab:c'], TABLE_PREFIXES, 'tab:')).to.equal('table:')
    expect(labelStyle(['fig:a'], TABLE_PREFIXES, 'tab:')).to.equal('tab:')
  })

  it('reads labels outside comments', function () {
    expect([...labelsIn('\\label{a} % \\label{b}\n\\label{ c }')]).to.deep.equal(['a', 'c'])
  })

  it('numbers a taken label', function () {
    expect(uniqueLabel('tab:x', new Set(['tab:x', 'tab:x-2']))).to.equal('tab:x-3')
    expect(uniqueLabel('tab:y', new Set())).to.equal('tab:y')
  })
})
