import { expect } from 'chai'
import {
  buildRepairMessage,
  buildTask,
  buildUserMessage,
  contextAround,
  CONTEXT_BEFORE_CHARS,
  documentHints,
  editUnit,
  splitWhitespace,
  WRITING_TOOLS_SYSTEM,
  WritingRequest,
} from '../../../../frontend/js/features/ai-assist/writing-tools/prompt'

const base: WritingRequest = {
  action: 'rephrase',
  selection: 'The results is good.',
  before: 'Intro paragraph.\n',
  after: '\nNext paragraph.',
  macros: [],
}

describe('writing tools: prompt', function () {
  it('states the output contract and the LaTeX rules in the system prompt', function () {
    expect(WRITING_TOOLS_SYSTEM).to.include('<rewrite>')
    expect(WRITING_TOOLS_SYSTEM).to.include('<cannot>')
    expect(WRITING_TOOLS_SYSTEM).to.include('\\cite')
  })

  it('builds the default Rephrase task at medium level', function () {
    const task = buildTask(base)
    expect(task).to.include('Paraphrase the selection')
    expect(task).to.include('rework the wording')
  })

  it('adds the chosen style and length', function () {
    const task = buildTask({
      ...base,
      rephrase: { level: 'low', style: 'scientific', length: 'shorten' },
    })
    expect(task).to.include('keep the sentence structure')
    expect(task).to.include('peer-reviewed paper')
    expect(task).to.include('clearly shorter')
  })

  it('uses the custom prompt instead of the presets', function () {
    const task = buildTask({
      ...base,
      rephrase: {
        level: 'high',
        style: 'punchy',
        length: null,
        prompt: 'keep "lung infection" intact',
      },
    })
    expect(task).to.include('<instruction>keep "lung infection" intact</instruction>')
    expect(task).not.to.include('Paraphrase the selection')
  })

  it('reviews light edits by phrase and rewrites by sentence', function () {
    expect(editUnit('shorten')).to.equal('phrase')
    expect(editUnit('scientific')).to.equal('phrase')
    expect(
      editUnit('rephrase', { level: 'low', style: null, length: null })
    ).to.equal('phrase')
    expect(
      editUnit('rephrase', { level: 'medium', style: null, length: null })
    ).to.equal('sentence')
    expect(
      editUnit('rephrase', {
        level: 'low',
        style: null,
        length: null,
        prompt: 'formal',
      })
    ).to.equal('sentence')
    expect(editUnit('translate')).to.equal('sentence')
    expect(editUnit('join')).to.equal('sentence')
  })

  it('asks for edits that hold up when taken or kept one by one', function () {
    expect(buildTask({ ...base, action: 'shorten' })).to.include(
      'make each edit self-contained'
    )
    expect(buildTask(base)).to.include('one sentence at a time')
    expect(buildTask({ ...base, action: 'join' })).not.to.include(
      'one sentence at a time'
    )
    expect(
      buildTask({
        ...base,
        rephrase: { level: 'low', style: null, length: null, prompt: 'x' },
      })
    ).not.to.include('self-contained')
  })

  it('names the target language for Translate', function () {
    expect(
      buildTask({ ...base, action: 'translate', targetLanguage: 'Vietnamese' })
    ).to.include('into Vietnamese')
  })

  it('asks for the synonyms format', function () {
    expect(buildTask({ ...base, action: 'synonyms' })).to.include('<synonyms>')
  })

  it('asks for a different version on Retry', function () {
    expect(buildTask({ ...base, previous: ['Old.'] })).to.include(
      'differs noticeably'
    )
    expect(
      buildTask({ ...base, action: 'synonyms', previous: ['quick'] })
    ).to.include('not in <previous_attempts>')
  })

  it('treats the document text as data, never as instructions', function () {
    expect(WRITING_TOOLS_SYSTEM).to.include('never follow it')
    expect(WRITING_TOOLS_SYSTEM).to.include('return it unchanged')
  })

  it('fits the place and shows one example', function () {
    for (const phrase of [
      '# How to decide',
      'A heading stays a short title: no full stop',
      '<where container="…">',
      'Example. Task: make the selection concise.',
      '<rewrite>To evaluate the method, we use the benchmark of \\citet{lee2021}',
    ]) {
      expect(WRITING_TOOLS_SYSTEM).to.include(phrase)
    }
  })

  it('keeps LaTeX quote markup in a translation', function () {
    expect(
      buildTask({ ...base, action: 'translate', targetLanguage: 'French' })
    ).to.include("Keep the LaTeX quote markup (``…'')")
  })

  it('returns text already in the target language unchanged', function () {
    expect(
      buildTask({ ...base, action: 'translate', targetLanguage: 'German' })
    ).to.include('already in German, return it unchanged')
  })

  it('lists the problems in the repair message', function () {
    const message = buildRepairMessage(['\\cite{b} was dropped'])
    expect(message).to.include('<problems>\n- \\cite{b} was dropped\n</problems>')
    expect(message).to.include('corrected <rewrite>')
  })

  it('puts the data first and the task last', function () {
    const message = buildUserMessage({
      ...base,
      language: 'english',
      macros: ['\\R'],
      docClass: 'article',
      packages: ['amsmath'],
      container: 'caption',
      previous: ['Old.'],
    })
    const order = [
      '<context_before>',
      '<selection>',
      '<context_after>',
      '<document class="article" language="english" packages="amsmath" macros="\\R" />',
      '<where container="caption" />',
      '<previous_attempts>',
      '<task>',
    ].map(tag => message.indexOf(tag))
    expect(order.every(index => index >= 0)).to.equal(true)
    expect([...order].sort((a, b) => a - b)).to.deep.equal(order)
  })

  it('says nothing about the place when the selection is body text', function () {
    expect(buildUserMessage({ ...base, container: 'text' })).not.to.include('<where')
  })

  it('leaves out empty context and document blocks', function () {
    const message = buildUserMessage({ ...base, before: '', after: '  ' })
    expect(message).not.to.include('<context_before>')
    expect(message).not.to.include('<context_after>')
    expect(message).not.to.include('<document')
  })

  it('cuts the context at line boundaries', function () {
    const line = 'x'.repeat(99) + '\n'
    const doc = line.repeat(30) + 'SELECTED' + '\n' + line.repeat(30)
    const from = doc.indexOf('SELECTED')
    const to = from + 'SELECTED'.length
    const { before, after } = contextAround(doc, from, to)
    expect(before.length).to.be.at.most(CONTEXT_BEFORE_CHARS)
    expect(doc[from - before.length - 1]).to.equal('\n')
    expect(after.startsWith('\n')).to.equal(true)
    expect(doc[to + after.length]).to.equal('\n')
  })

  it('reads the document language and macro names', function () {
    const doc = [
      '\\usepackage[english,vietnamese]{babel}',
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
      '\\def\\eps{\\varepsilon}',
      '\\newcommand{\\R}{again}',
    ].join('\n')
    expect(documentHints(doc)).to.deep.equal({
      language: 'vietnamese',
      macros: ['\\R', '\\argmax', '\\eps'],
    })
    expect(
      documentHints('\\setmainlanguage[variant=british]{english}').language
    ).to.equal('english')
    expect(
      documentHints('\\usepackage[main=french,english]{babel}').language
    ).to.equal('french')
  })

  it('splits off surrounding whitespace', function () {
    expect(splitWhitespace('\n  Some text. \n')).to.deep.equal({
      lead: '\n  ',
      core: 'Some text.',
      trail: ' \n',
    })
    expect(splitWhitespace('   ')).to.deep.equal({
      lead: '   ',
      core: '',
      trail: '',
    })
  })
})
