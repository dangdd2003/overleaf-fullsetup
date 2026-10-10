import { expect } from 'chai'
import { parseReply } from '../../../../frontend/js/features/ai-assist/language-suggestions/parse-reply'

describe('language suggestions: reply parser', function () {
  it('reads every complete sentence', function () {
    expect(
      parseReply('<s id="s1">One is fixed.</s>\n<s id="s3"> Three too. </s>', true)
    ).to.deep.equal({
      sentences: [
        { id: 's1', kind: 'grammar', text: 'One is fixed.' },
        { id: 's3', kind: 'grammar', text: 'Three too.' },
      ],
      none: false,
      malformed: false,
    })
  })

  it('waits for a sentence to close while streaming', function () {
    expect(parseReply('<s id="s1">One is fixed.</s>\n<s id="s2">Two is', false).sentences).to.deep.equal([
      { id: 's1', kind: 'grammar', text: 'One is fixed.' },
    ])
  })

  it('shows nothing while the model is still reasoning, and drops the reasoning after', function () {
    expect(parseReply('<think>Let me look', false)).to.deep.equal({
      sentences: [],
      none: false,
      malformed: false,
    })
    expect(
      parseReply('<think>s1 has an error</think><s id="s1">Fixed.</s>', true).sentences
    ).to.deep.equal([{ id: 's1', kind: 'grammar', text: 'Fixed.' }])
  })

  it('understands "nothing to change", including an empty reply', function () {
    expect(parseReply('<none/>', true)).to.deep.equal({ sentences: [], none: true, malformed: false })
    expect(parseReply('  ', true)).to.deep.equal({ sentences: [], none: false, malformed: false })
  })

  it('flags a finished reply that follows no part of the contract', function () {
    expect(parseReply('Sure! The text looks good to me.', true).malformed).to.equal(true)
    expect(parseReply('Sure! The text looks good to me.', false).malformed).to.equal(false)
  })

  it('reads through code fences, keeps the first copy of an id, and undoes escaped closing tags', function () {
    expect(
      parseReply('```xml\n<s id="s1">A <\\/s> b.</s>\n<s id="s1">Again.</s>\n```', true).sentences
    ).to.deep.equal([{ id: 's1', kind: 'grammar', text: 'A </s> b.' }])
  })
  it('reads a correction and a rewording of the same sentence', function () {
    const { sentences } = parseReply(
      '<s id="s1" kind="grammar" why="agreement">It work well.</s><s id="s1" kind="style" why="precision">It converges well.</s>',
      true
    )
    expect(sentences).to.deep.equal([
      { id: 's1', kind: 'grammar', text: 'It work well.', why: 'agreement' },
      { id: 's1', kind: 'style', text: 'It converges well.', why: 'precision' },
    ])
  })

  it('reads the why attribute, in either order, and still reads sentences without it', function () {
    const { sentences } = parseReply(
      '<s id="s1" why="agreement">The results show it.</s>\n<s why="typo" id="s2">A test.</s>\n<s id="s3">Plain one.</s>',
      true
    )
    expect(sentences).to.deep.equal([
      { id: 's1', kind: 'grammar', text: 'The results show it.', why: 'agreement' },
      { id: 's2', kind: 'grammar', text: 'A test.', why: 'typo' },
      { id: 's3', kind: 'grammar', text: 'Plain one.' },
    ])
  })
})
