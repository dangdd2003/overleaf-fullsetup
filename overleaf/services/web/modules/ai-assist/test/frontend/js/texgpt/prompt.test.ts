import { expect } from 'chai'
import {
  buildFollowUpMessage,
  buildRepairMessage,
  buildRequestMessage,
  RETRY_MESSAGE,
  TEXGPT_SYSTEM,
  TexGptRequest,
  whereTag,
} from '../../../../frontend/js/features/ai-assist/texgpt/prompt'

const BASE: TexGptRequest = {
  prompt: 'Write a table of symbols',
  before: 'Intro.\n',
  after: '\nMore.',
  docClass: 'article',
  language: 'english',
  macros: ['\\R'],
  packages: ['amsmath', 'booktabs'],
}

describe('texgpt: prompt', function () {
  it('sends the document, where the cursor is, the context and then the request', function () {
    const message = buildRequestMessage({
      ...BASE,
      where: { region: 'body', section: 'Method', envs: [], container: 'text', line: 'empty' },
      citeKeys: ['smith2021', 'lee2020'],
      labels: ['tab:main'],
    })
    expect(message).to.equal(
      [
        '<document class="article" language="english" packages="amsmath booktabs" macros="\\R" cite_keys="smith2021 lee2020" labels="tab:main" />',
        '<where region="body" section="Method" line="empty" />',
        '<context>\nIntro.\n<cursor/>\nMore.\n</context>',
        '<request>\nWrite a table of symbols\n</request>',
      ].join('\n\n')
    )
  })

  it('marks the selection inside the context', function () {
    const message = buildRequestMessage({ ...BASE, selection: 'teh result' })
    expect(message).to.include(
      '<context>\nIntro.\n<selection>teh result</selection>\nMore.\n</context>'
    )
    expect(message).not.to.include('<cursor/>')
  })

  it('escapes the where tag and lists the environments', function () {
    expect(
      whereTag({
        region: 'body',
        section: 'A "B" <C>',
        envs: ['figure', 'center'],
        container: 'caption',
      })
    ).to.equal(
      '<where region="body" section="A &quot;B&quot; &lt;C&gt;" env="figure center" container="caption" />'
    )
  })

  it('sends a generator its task and the paper, without the cursor', function () {
    const message = buildRequestMessage({
      ...BASE,
      prompt: undefined,
      generator: 'abstract',
      before: '',
      after: '',
      paper: 'The paper.',
    })
    expect(message).to.include('<paper>\nThe paper.\n</paper>')
    expect(message).to.include('<task>\nWrite the abstract')
    expect(message).not.to.include('<request>')
    expect(message).not.to.include('<context>')
    expect(message).not.to.include('<where')
  })

  it('states the reply contract in the system prompt', function () {
    for (const tag of ['<latex>', '<packages>', '<answer>', '<cannot>']) {
      expect(TEXGPT_SYSTEM).to.include(tag)
    }
  })

  it('tells the model how to read the cursor and what to do there', function () {
    for (const phrase of [
      'Decide what to do (the first rule that applies)',
      'region="preamble": write preamble code only',
      'line="middle": write only words that fit into the sentence',
      'Cite only keys listed in cite_keys',
      '% TODO: cite',
      '<latex>\\item Latency is measured end to end~\\cite{smith2021}.</latex>',
    ]) {
      expect(TEXGPT_SYSTEM).to.include(phrase)
    }
  })

  it('wraps follow-ups, retries and repairs', function () {
    expect(buildFollowUpMessage('add a caption')).to.include(
      '<request>\nadd a caption\n</request>'
    )
    expect(RETRY_MESSAGE).to.include('differs')
    expect(buildRepairMessage(['Braces { } do not balance'])).to.include(
      '- Braces { } do not balance'
    )
  })
})
