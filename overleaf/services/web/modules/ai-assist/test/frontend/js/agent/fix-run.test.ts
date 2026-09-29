import { expect } from 'chai'
import { TranscriptEntry } from '../../../../frontend/js/features/ai-assist/agent/agent-messages'
import {
  FIX_TOOLS,
  FIX_TASK_BLOCK,
  buildFixTaskBlock,
  buildFixTranscript,
} from '../../../../frontend/js/features/ai-assist/agent/fix-run'
import { createFakeHandle } from './helpers/fake-handle'

const FOCUSED = {
  level: 'error',
  message: 'Undefined control sequence',
  raw: 'l.87 \\includegraphics',
  file: 'chapter3.tex',
  line: 87,
}

describe('fix-run', function () {
  it('offers tools excluding compile and create', function () {
    expect(Object.keys(FIX_TOOLS).sort()).to.deep.equal([
      'edit_file',
      'get_compile_result',
      'get_outline',
      'get_packages',
      'get_references',
      'list_files',
      'read_file',
      'search_text',
    ])
    expect(FIX_TOOLS).to.not.have.property('compile_project')
    expect(FIX_TOOLS).to.not.have.property('create_file')
  })

  // The panel this run renders into has no composer: a question or an offer
  // to investigate is a dead end, and narration between tool calls is what
  // turns one click into three assistant turns.
  it('tells the model nobody can reply, so it must not ask or narrate', function () {
    expect(FIX_TASK_BLOCK).to.include('no reply box')
    expect(FIX_TASK_BLOCK).to.match(/never end with a question/)
    expect(FIX_TASK_BLOCK).to.match(/no text between/)
  })

  it('demands an edit, never an explanation in its place', function () {
    expect(FIX_TASK_BLOCK).to.include('Call edit_file')
    expect(FIX_TASK_BLOCK).to.match(/being unsure is not a reason to withhold it/)
    expect(FIX_TASK_BLOCK).to.match(/never replace\s+the edit with instructions/)
    expect(FIX_TASK_BLOCK).to.not.match(/make no edit/)
  })

  it('still proposes a safe change for a warning the author could live with', function () {
    expect(FIX_TASK_BLOCK).to.match(/still propose the safe change/)
  })

  it('ranks fixes by how invasive they are', function () {
    expect(FIX_TASK_BLOCK).to.match(/least invasive/)
    expect(FIX_TASK_BLOCK).to.match(/argument before you add a package/)
  })

  it('calls a warning a warning, so the model does not "fix" a remark', function () {
    expect(buildFixTaskBlock('warning')).to.include('on the compile warning')
    expect(buildFixTaskBlock('warning')).to.not.include('on the compile error')
    expect(buildFixTaskBlock('error')).to.include('on the compile error')
    // Anything that is not a warning is treated as an error.
    expect(buildFixTaskBlock('')).to.include('on the compile error')
  })

  // A fix is a local question, so the turn carries the lines themselves, not
  // the rail's summary of the whole project. Shipping the code is what lets
  // the common entry be answered without spending a single tool call.
  it('builds one user entry carrying the code, not a project summary', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}',
        'chapter3.tex': Array.from(
          { length: 100 },
          (_, i) => `line ${i + 1}`
        ).join('\n'),
      },
    })
    const transcript = await buildFixTranscript({
      handle,
      focused: FOCUSED,
      others: [],
    })

    expect(transcript).to.have.length(1)
    const entry = transcript[0] as Extract<TranscriptEntry, { role: 'user' }>
    expect(entry.role).to.equal('user')
    expect(entry.contextText).to.contain('<source file="chapter3.tex"')
    // The entry's own line is marked, and its neighbours come with it.
    expect(entry.contextText).to.contain('entry-line="87"')
    expect(entry.contextText).to.contain('87: line 87')
    // The preamble rides along: a missing \usepackage is the commonest cause.
    expect(entry.contextText).to.contain('<preamble file="main.tex"')
    expect(entry.contextText).to.contain('\\documentclass{article}')
    expect(entry.contextText).to.contain('<compile-error')
    // The project-wide envelope is gone on purpose.
    expect(entry.contextText).to.not.contain('<project-context')
    expect(entry.text).to.equal(FIX_TASK_BLOCK)
    expect(entry.attachments).to.deep.equal([])
  })

  it('cuts the preamble at \\begin{document}', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': [
          '\\documentclass{article}',
          '\\usepackage{graphicx}',
          '\\begin{document}',
          'BODY_SENTINEL',
          '\\end{document}',
        ].join('\n'),
      },
    })
    const transcript = await buildFixTranscript({
      handle,
      focused: { ...FOCUSED, file: 'other.tex' },
      others: [],
    })

    const entry = transcript[0] as Extract<TranscriptEntry, { role: 'user' }>
    expect(entry.contextText).to.contain('\\usepackage{graphicx}')
    expect(entry.contextText).to.not.contain('BODY_SENTINEL')
  })

  it('names the entry a warning, not an error, when it is one', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    const transcript = await buildFixTranscript({
      handle,
      focused: { ...FOCUSED, level: 'warning' },
      others: [],
    })

    const entry = transcript[0] as Extract<TranscriptEntry, { role: 'user' }>
    expect(entry.text).to.include('compile warning above')
    expect(entry.text).to.not.include('compile error above')
    // The contract itself is level-independent.
    expect(entry.text).to.include('no reply box')
  })

  it('still explains the error when the source cannot be read', async function () {
    const { handle } = createFakeHandle({})
    handle.readFile = async () => {
      throw new Error('file unavailable')
    }

    const transcript = await buildFixTranscript({
      handle,
      focused: FOCUSED,
      others: [],
    })

    expect(transcript).to.have.length(1)
    const entry = transcript[0] as Extract<TranscriptEntry, { role: 'user' }>
    expect(entry.contextText).to.contain('<compile-error')
    expect(entry.contextText).to.not.contain('<project-context')
  })
})
