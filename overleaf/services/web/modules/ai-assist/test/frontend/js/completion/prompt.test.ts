import { expect } from 'chai'
import {
  buildCompletionMessage,
  COMPLETION_SYSTEM,
  CURSOR,
  MAX_TOKENS,
} from '../../../../frontend/js/features/ai-assist/completion/prompt'
import { describeCursor } from '../../../../frontend/js/features/ai-assist/completion/placement'
import type { CompletionKind } from '../../../../frontend/js/features/ai-assist/completion/detect'

const FACTS = {
  docClass: 'article',
  packages: ['amsmath'],
  macros: ['\\R'],
  title: 'Fast Solvers',
  abstract: 'We study fast solvers for sparse systems.',
  outline: ['Introduction', 'Method'],
  section: 'Method',
  envs: ['itemize'],
  labels: ['sec:intro'],
  cites: ['knuth'],
}

/** The message for the cursor at the `|` of `doc`. */
function messageAt(doc: string, kind: CompletionKind = 'prose', rejected?: string, facts = FACTS) {
  const pos = doc.lastIndexOf('|')
  const text = doc.slice(0, pos) + doc.slice(pos + 1)
  const situation = describeCursor(text, pos, kind, kind === 'math')
  return buildCompletionMessage({
    window: { prefix: text.slice(0, pos), suffix: text.slice(pos), atStart: true },
    facts,
    kind,
    situation,
    rejected,
  })
}

describe('completion: prompts', function () {
  it('the system prompt: a completion engine continuing the author, nothing else', function () {
    expect(COMPLETION_SYSTEM).to.include('autocompletion engine of a LaTeX editor')
    expect(COMPLETION_SYSTEM).to.include(CURSOR)
    expect(COMPLETION_SYSTEM).to.include('grammatical')
    expect(COMPLETION_SYSTEM).to.include('do not invent references')
    expect(COMPLETION_SYSTEM).to.include('Reply with only the text to insert')
    expect(MAX_TOKENS).to.deep.equal({ prose: 160, math: 120, block: 700, code: 300 })
  })

  it('the facts, the excerpt with the cursor marked, then the task', function () {
    const message = messageAt('Our method|\n\nNext paragraph.')
    expect(message).to.include('<document class="article" packages="amsmath" macros="\\R" />')
    expect(message).to.include('<title>Fast Solvers</title>')
    expect(message).to.include('<abstract>We study fast solvers for sparse systems.</abstract>')
    expect(message).to.include('<outline>Introduction / Method</outline>')
    expect(message).to.include('<section>Method</section>')
    expect(message).to.include('<keys labels="sec:intro" citations="knuth" />')
    expect(message).to.include(`<excerpt start="document">\nOur method${CURSOR}\n\nNext paragraph.\n</excerpt>`)
    const task = message.slice(message.indexOf('<task>'))
    expect(task).to.include('in the middle of a sentence')
    expect(task).to.include('Length: the rest of this sentence')
    expect(task).to.include('Your text is inserted right after: "Our method"')
    expect(message.indexOf('<excerpt')).to.be.below(message.indexOf('<task>'))
  })

  it('leaves out the abstract once the excerpt shows it, and facts the document lacks', function () {
    const doc = '\\begin{abstract}\nWe study fast solvers for sparse systems.\n\\end{abstract}\nOur |'
    expect(messageAt(doc)).to.not.include('<abstract>')
    const bare = messageAt('Our method|', 'prose', undefined, {
      docClass: null,
      packages: [],
      macros: [],
      outline: [],
      section: '',
      envs: [],
      labels: [],
      cites: [],
    } as any)
    expect(bare.startsWith('<excerpt')).to.equal(true)
  })

  it('a length for each place', function () {
    expect(messageAt('Our method works.|')).to.include('Length: one sentence of at most about 35 words.')
    expect(messageAt('$a + |$', 'math')).to.include('Length: the rest of this expression')
    expect(messageAt('\\begin{lstlisting}\nx = 1\n|\n\\end{lstlisting}', 'code')).to.include('at most six lines')
    expect(messageAt('\\begin{itemize}\n\\item One.\n|\n\\end{itemize}', 'block')).to.include('one row or item')
    expect(messageAt('\\section{Results on |}')).to.include('only what the argument still needs')
  })

  it('no join hint where the reply starts on a new line', function () {
    expect(messageAt('\\section{Method}|', 'block')).to.not.include('inserted right after')
  })

  it('asks for different words when the author dismissed a suggestion', function () {
    expect(messageAt('Our method|', 'prose', ' outperforms it.')).to.include(
      'The author dismissed this suggestion; write a different continuation: "outperforms it."'
    )
    expect(messageAt('Our method|')).to.not.include('dismissed')
  })
})
