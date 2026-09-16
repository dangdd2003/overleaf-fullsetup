import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen } from '@testing-library/react'
import {
  STATUS_WORDS,
  formatElapsed,
  formatDuration,
  toPastTense,
  formatCompletedStatus,
  nextStatusWord,
  getThinkingStatus,
  DEEP_THINKING_WORDS,
} from '../../../../../frontend/js/features/ai-assist/components/agent/status-words'
import { AgentStatusLine } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-status-line'
import { SubresultGroup } from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-group'

describe('formatElapsed', function () {
  it('says nothing for a run that has barely started', function () {
    expect(formatElapsed(0)).to.equal('')
    expect(formatElapsed(400)).to.equal('')
  })

  it('counts in whole seconds under a minute', function () {
    expect(formatElapsed(1000)).to.equal('1s')
    expect(formatElapsed(12400)).to.equal('12s')
    expect(formatElapsed(59000)).to.equal('59s')
  })

  it('switches to minutes and seconds past a minute', function () {
    expect(formatElapsed(67000)).to.equal('1m 7s')
    expect(formatElapsed(600000)).to.equal('10m 0s')
  })
})

describe('the status vocabulary', function () {
  it('never reuses a word a tool action already owns', function () {
    // "Reading main.tex…" is a fact about a live tool call. If the idle
    // spinner could also say "Reading…", the two lines would contradict each
    // other — one reporting a real action, one just passing the time.
    const toolVerbs = [
      'Reading',
      'Editing',
      'Searching',
      'Compiling',
      'Creating',
      'Listing',
      'Mapping',
    ]
    for (const word of STATUS_WORDS) {
      expect(toolVerbs).to.not.include(word)
    }
  })

  it('offers enough variety to not repeat quickly', function () {
    expect(STATUS_WORDS.length).to.be.greaterThan(20)
  })

  it('includes some Overleaf and LaTeX flavour', function () {
    expect(STATUS_WORDS).to.include('Overleafing')
    expect(STATUS_WORDS).to.include('Typesetting')
    expect(STATUS_WORDS).to.include('Kerning')
  })

  it('never hands back the word it just showed', function () {
    for (const current of STATUS_WORDS) {
      expect(nextStatusWord(current)).to.not.equal(current)
    }
  })

  it('picks a real word when there is no previous one', function () {
    expect(STATUS_WORDS).to.include(nextStatusWord(null))
  })
})

describe('getThinkingStatus token tiers', function () {
  it('returns appropriate progressive phrases based on token count', function () {
    expect(getThinkingStatus(0)).to.equal('Thinking…')
    expect(getThinkingStatus(100)).to.equal('Thinking…')
    expect(getThinkingStatus(249)).to.equal('Thinking…')

    expect(getThinkingStatus(250)).to.equal('Still thinking…')
    expect(getThinkingStatus(500)).to.equal('Still thinking…')
    expect(getThinkingStatus(749)).to.equal('Still thinking…')

    expect(getThinkingStatus(750)).to.equal('Thinking deeply…')
    expect(getThinkingStatus(1499)).to.equal('Thinking deeply…')

    expect(getThinkingStatus(1500)).to.equal('Pondering the solution…')
    expect(getThinkingStatus(2999)).to.equal('Pondering the solution…')

    expect(getThinkingStatus(3000)).to.equal('Working through complex reasoning…')
    expect(getThinkingStatus(4999)).to.equal('Working through complex reasoning…')
  })

  it('progresses through deep thinking words beyond 5000 tokens', function () {
    expect(getThinkingStatus(5000)).to.equal(DEEP_THINKING_WORDS[0])
    expect(getThinkingStatus(6000)).to.equal(DEEP_THINKING_WORDS[1])
    expect(getThinkingStatus(7000)).to.equal(DEEP_THINKING_WORDS[2])
    expect(getThinkingStatus(8000)).to.equal(DEEP_THINKING_WORDS[3])
    expect(getThinkingStatus(9000)).to.equal(DEEP_THINKING_WORDS[4])
    // Cycles back around
    expect(getThinkingStatus(10000)).to.equal(DEEP_THINKING_WORDS[0])
  })
})

describe('AgentStatusLine', function () {
  let clock: sinon.SinonFakeTimers

  afterEach(function () {
    clock?.restore()
    sinon.restore()
  })

  it('shows a whimsical status word while the run is live', function () {
    render(<AgentStatusLine startedAt={Date.now()} />)

    const line = screen.getByRole('status')
    expect(STATUS_WORDS.some(word => line.textContent?.includes(word))).to.equal(
      true
    )
  })

  it('puts the elapsed time before the word, as Claude Code does', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({ now: started + 67000, toFake: ['setInterval', 'clearInterval', 'Date'] })

    render(<AgentStatusLine startedAt={started} />)

    const text = screen.getByRole('status').textContent ?? ''
    expect(text).to.contain('1m 7s')
    expect(text).to.contain('·')
    expect(text.indexOf('1m 7s')).to.be.lessThan(text.indexOf('·'))
  })

  it('renders a spinner alongside the text', function () {
    const { container } = render(<AgentStatusLine startedAt={Date.now()} />)

    expect(container.querySelector('.ai-assist-status-spinner')).to.exist
  })

  it('stands on its own line, outside any activity group', function () {
    const { container } = render(<AgentStatusLine startedAt={Date.now()} />)

    const line = container.querySelector('.ai-assist-status-line')
    expect(line).to.exist
    expect(line!.closest('.ai-assist-subresult-group')).to.equal(null)
  })

  it('shows thinking status and transitions to still thinking as thinking tokens accumulate', function () {
    const started = Date.now()
    const { rerender } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[{ type: 'thinking', thinking: 'planning...', startedAt: started }]}
      />
    )
    expect(screen.getByRole('status').textContent).to.contain('Thinking…')

    // 1500 characters / 3.7 chars-per-token ≈ 405 tokens (tier: [250, 750) -> 'Still thinking…')
    rerender(
      <AgentStatusLine
        startedAt={started}
        blocks={[{ type: 'thinking', thinking: 'a'.repeat(1500), startedAt: started }]}
      />
    )
    expect(screen.getByRole('status').textContent).to.contain('Still thinking…')

    // 6000 characters / 3.7 chars-per-token ≈ 1622 tokens (tier: [1500, 3000) -> 'Pondering the solution…')
    rerender(
      <AgentStatusLine
        startedAt={started}
        blocks={[{ type: 'thinking', thinking: 'a'.repeat(6000), startedAt: started }]}
      />
    )
    expect(screen.getByRole('status').textContent).to.contain('Pondering the solution…')
  })

  it('shows a rotating whimsical word while a tool call is in flight, never flickering transient verbs', function () {
    render(
      <AgentStatusLine
        startedAt={Date.now()}
        blocks={[
          {
            type: 'tool_call',
            call: { id: 'c1', name: 'read_file', args: { path: 'main.tex' } },
          },
        ]}
      />
    )
    const text = screen.getByRole('status').textContent || ''
    expect(text).to.not.contain('Reading main.tex…')
    expect(STATUS_WORDS.some(word => text.includes(word))).to.equal(true)
  })

  it('shows a rotating whimsical word for search_project tool, never flickering search queries', function () {
    render(
      <AgentStatusLine
        startedAt={Date.now()}
        blocks={[
          {
            type: 'tool_call',
            call: { id: 'c2', name: 'search_project', args: { query: '\\label' } },
          },
        ]}
      />
    )
    const text = screen.getByRole('status').textContent || ''
    expect(text).to.not.contain('Searching for')
    expect(STATUS_WORDS.some(word => text.includes(word))).to.equal(true)
  })

  it('finishes the counter and renders nothing when pendingApproval requests user input', function () {
    const { container } = render(
      <AgentStatusLine
        startedAt={Date.now()}
        blocks={[
          {
            type: 'tool_call',
            call: { id: 'c3', name: 'edit_file', args: { path: 'main.tex' } },
          },
        ]}
        pendingApproval={{ id: 'c3', edit: { path: 'main.tex', oldText: 'a', newText: 'b' } }}
      />
    )
    expect(container.querySelector('.ai-assist-status-line')).to.be.null
  })

  it('shows fancy rotating text when generating text', function () {
    render(
      <AgentStatusLine
        startedAt={Date.now()}
        blocks={[
          {
            type: 'text',
            text: 'Here is the answer...',
          },
        ]}
      />
    )
    const line = screen.getByRole('status')
    expect(STATUS_WORDS.some(word => line.textContent?.includes(word))).to.equal(true)
  })

  it('renders completed status line with static icon and total time when isRunning is false', function () {
    const { container } = render(
      <AgentStatusLine
        startedAt={Date.now() - 14000}
        isRunning={false}
        durationMs={14000}
        completedWord="Brewing"
      />
    )

    const line = container.querySelector('.ai-assist-status-line')
    expect(line).to.exist
    expect(line?.classList.contains('is-completed')).to.be.true

    // Must render the static Overleaf icon, NOT the blooming spinner
    expect(container.querySelector('.ai-assist-status-icon-static')).to.exist
    expect(container.querySelector('.ai-assist-status-mark-static')).to.exist
    expect(container.querySelector('.ai-assist-status-spinner')).to.not.exist

    expect(line?.textContent).to.equal('Brewed for 14s')
  })

  it('formats custom completed words and durations accurately', function () {
    const { rerender } = render(
      <AgentStatusLine
        startedAt={Date.now() - 67000}
        isRunning={false}
        durationMs={67000}
        completedWord="Typesetting"
      />
    )
    expect(screen.getByRole('status').textContent).to.equal('Typeset for 1m 7s')

    rerender(
      <AgentStatusLine
        startedAt={Date.now() - 400}
        isRunning={false}
        durationMs={400}
        completedWord="Working"
      />
    )
    expect(screen.getByRole('status').textContent).to.equal('Worked for 1s')
  })

  it('notifies onWordChange when status word is chosen or rotates', function () {
    const wordSpy = sinon.spy()
    render(
      <AgentStatusLine
        startedAt={Date.now()}
        isRunning={true}
        onWordChange={wordSpy}
      />
    )
    expect(wordSpy.calledOnce).to.be.true
    expect(STATUS_WORDS).to.include(wordSpy.firstCall.args[0])
  })
})

describe('formatDuration and toPastTense', function () {
  it('formats duration for completed runs', function () {
    expect(formatDuration(0)).to.equal('1s')
    expect(formatDuration(400)).to.equal('1s')
    expect(formatDuration(1000)).to.equal('1s')
    expect(formatDuration(12000)).to.equal('12s')
    expect(formatDuration(59000)).to.equal('59s')
    expect(formatDuration(60000)).to.equal('1m')
    expect(formatDuration(67000)).to.equal('1m 7s')
    expect(formatDuration(120000)).to.equal('2m')
    expect(formatDuration(125000)).to.equal('2m 5s')
  })

  it('converts fancy status words to past tense', function () {
    expect(toPastTense('Brewing')).to.equal('Brewed')
    expect(toPastTense('Brewing…')).to.equal('Brewed')
    expect(toPastTense('Typesetting')).to.equal('Typeset')
    expect(toPastTense('Typesetting…')).to.equal('Typeset')
    expect(toPastTense('Kerning')).to.equal('Kerned')
    expect(toPastTense('TeXing')).to.equal('TeXed')
    expect(toPastTense('Knuthing')).to.equal('Knuthed')
    expect(toPastTense('Working')).to.equal('Worked')
    expect(toPastTense('Thinking')).to.equal('Thought')
    expect(toPastTense('Proofreading')).to.equal('Proofread')
    expect(toPastTense('Brewed')).to.equal('Brewed')
    expect(toPastTense('Worked')).to.equal('Worked')
  })

  it('formats full completed status string like Claude Code', function () {
    expect(formatCompletedStatus('Brewing', 12000)).to.equal('Brewed for 12s')
    expect(formatCompletedStatus('Typesetting…', 67000)).to.equal('Typeset for 1m 7s')
    expect(formatCompletedStatus('Working', 500)).to.equal('Worked for 1s')
  })
})

describe('the activity line stays out of the status line\'s job', function () {
  it('renders no activity group at all for a live run with no blocks', function () {
    const { container } = render(
      <SubresultGroup items={[]} isLive onDecision={() => {}} />
    )

    expect(container.querySelector('.ai-assist-subresult-group')).to.equal(null)
  })

  it('shows only the tally, never a stand-in status word', function () {
    render(
      <SubresultGroup
        items={[
          {
            type: 'tool_call',
            call: { id: '1', name: 'read_file', args: {}, result: {} },
          },
        ]}
        isLive
        onDecision={() => {}}
      />
    )

    const header = screen.getByRole('button')
    expect(header.textContent).to.contain('Read 1 file')
    expect(header.textContent).to.not.contain('Thinking')
    expect(header.textContent).to.not.contain('Working')
  })
})
