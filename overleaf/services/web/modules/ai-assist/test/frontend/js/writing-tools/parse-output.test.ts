import { expect } from 'chai'
import {
  ParsedRewrite,
  parseRewrite,
  parseSynonyms,
} from '../../../../frontend/js/features/ai-assist/writing-tools/parse-output'

function textOf(parsed: ParsedRewrite): string {
  if (parsed.kind !== 'rewrite') throw new Error(`got ${parsed.kind}`)
  return parsed.text
}

describe('writing tools: parseRewrite', function () {
  it('reads a complete rewrite block', function () {
    expect(parseRewrite('<rewrite>\nNew text.\n</rewrite>', true)).to.deep.equal(
      { kind: 'rewrite', text: 'New text.', complete: true }
    )
  })

  it('shows the body while streaming and hides a partial closing tag', function () {
    expect(parseRewrite('<rewrite>New te', false)).to.deep.equal({
      kind: 'rewrite',
      text: 'New te',
      complete: false,
    })
    expect(textOf(parseRewrite('<rewrite>New text.</rew', false))).to.equal(
      'New text.'
    )
  })

  it('shows nothing while the opening tag is still arriving', function () {
    expect(parseRewrite('<rew', false)).to.deep.equal({
      kind: 'rewrite',
      text: '',
      complete: false,
    })
    expect(textOf(parseRewrite('', false))).to.equal('')
  })

  it('reads a cannot block', function () {
    expect(
      parseRewrite('<cannot>The selection holds no prose.</cannot>', true)
    ).to.deep.equal({
      kind: 'cannot',
      reason: 'The selection holds no prose.',
      complete: true,
    })
  })

  it('takes an untagged reply as the rewrite, without code fences', function () {
    expect(parseRewrite('```latex\nNew \\emph{text}.\n```', true)).to.deep.equal(
      { kind: 'rewrite', text: 'New \\emph{text}.', complete: true }
    )
    expect(textOf(parseRewrite('Plain reply', true))).to.equal('Plain reply')
  })

  it('drops reasoning a model writes into the reply', function () {
    expect(
      textOf(parseRewrite('<think>plan it</think>\n<rewrite>Done.</rewrite>', true))
    ).to.equal('Done.')
    expect(textOf(parseRewrite('<think>still planning', false))).to.equal('')
    expect(textOf(parseRewrite('<think>a</think>Untagged.', true))).to.equal(
      'Untagged.'
    )
  })

  it('drops code fences and echoed tags inside the block', function () {
    expect(
      textOf(parseRewrite('<rewrite>```latex\nNew.\n```</rewrite>', true))
    ).to.equal('New.')
    expect(
      textOf(parseRewrite('<rewrite><selection>New.</selection></rewrite>', true))
    ).to.equal('New.')
  })

  it('drops a chatty preface from an untagged reply only', function () {
    expect(
      textOf(parseRewrite("Sure! Here's the revised text:\n\nNew text.", true))
    ).to.equal('New text.')
    expect(
      textOf(parseRewrite('Here are the main results:\n\\begin{itemize}', true))
    ).to.equal('Here are the main results:\n\\begin{itemize}')
  })

  it('ignores anything after the closing tag', function () {
    expect(
      textOf(parseRewrite('<rewrite>Kept.</rewrite>\nI changed the tone.', true))
    ).to.equal('Kept.')
  })
})

describe('writing tools: parseSynonyms', function () {
  it('reads the options in order, deduplicated', function () {
    expect(
      parseSynonyms(
        '<synonyms><s>rapid</s><s>swift</s><s>Rapid</s></synonyms>',
        true
      )
    ).to.deep.equal({
      kind: 'synonyms',
      options: ['rapid', 'swift'],
      complete: true,
    })
  })

  it('falls back to one option per line', function () {
    expect(parseSynonyms('1. rapid\n2. swift\n- speedy', true)).to.deep.equal({
      kind: 'synonyms',
      options: ['rapid', 'swift', 'speedy'],
      complete: true,
    })
  })

  it('strips quotes and a closing full stop from options', function () {
    expect(
      parseSynonyms('<synonyms><s>"rapid"</s><s>swift.</s><s>e.g.</s></synonyms>', true)
    ).to.deep.equal({
      kind: 'synonyms',
      options: ['rapid', 'swift', 'e.g.'],
      complete: true,
    })
  })

  it('passes a cannot reply through', function () {
    expect(parseSynonyms('<cannot>No word selected.</cannot>', true).kind).to.equal(
      'cannot'
    )
  })
})
