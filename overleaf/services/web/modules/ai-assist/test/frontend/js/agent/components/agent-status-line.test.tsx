import { expect } from 'chai'
import sinon from 'sinon'
import { act, render, screen } from '@testing-library/react'
import {
  STATUS_WORDS,
  formatElapsed,
  formatDuration,
  toPastTense,
  formatCompletedStatus,
  nextStatusWord,
  deriveStatusMode,
  formatTokenCount,
  thinkingPhrase,
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

describe('deriveStatusMode', function () {
  it('reads the live stream the way Claude Code does', function () {
    expect(deriveStatusMode([])).to.equal('requesting')
    expect(
      deriveStatusMode([{ type: 'thinking', thinking: 'hm', startedAt: 1 }])
    ).to.equal('thinking')
    expect(deriveStatusMode([{ type: 'text', text: 'Hi' }])).to.equal(
      'responding'
    )
    expect(
      deriveStatusMode([
        { type: 'tool_call', call: { id: 'a', name: 'read_file', args: {} } },
      ])
    ).to.equal('tool')
    // A finished tool call leaves the run waiting on the provider again.
    expect(
      deriveStatusMode([
        {
          type: 'tool_call',
          call: { id: 'a', name: 'read_file', args: {}, result: 'ok' },
        },
      ])
    ).to.equal('requesting')
  })
})

describe('formatTokenCount', function () {
  it('abbreviates thousands', function () {
    expect(formatTokenCount(840)).to.equal('840')
    expect(formatTokenCount(1234)).to.equal('1.2k')
    expect(formatTokenCount(12400)).to.equal('12.4k')
  })
})

describe('thinkingPhrase', function () {
  it("climbs Claude Code's ladder with the length of the thought", function () {
    expect(thinkingPhrase(0)).to.equal('Thinking')
    expect(thinkingPhrase(10000)).to.equal('Still thinking')
    expect(thinkingPhrase(20000)).to.equal('Thinking more')
    expect(thinkingPhrase(30000)).to.equal('Thinking some more')
    expect(thinkingPhrase(45000)).to.equal('Deep in thought')
    expect(thinkingPhrase(600000)).to.equal('Deep in thought')
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
    expect(
      STATUS_WORDS.some(word => line.textContent?.includes(word))
    ).to.equal(true)
  })

  it('shows only the word while the reply streams, never the counters beside it', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started + 67000,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    const { container } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[{ type: 'text', text: 'a'.repeat(4000) }]}
      />
    )

    expect(container.querySelector('.ai-assist-status-meta')).to.equal(null)
    expect(screen.getByRole('status').textContent).to.match(/^\S+…$/)
  })

  it('switches to time, tokens and "Running tools…" while a tool runs', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started + 161000,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    render(
      <AgentStatusLine
        startedAt={started}
        blocks={[
          {
            type: 'tool_call',
            call: { id: 'c', name: 'read_file', args: { path: 'main.tex' } },
          },
        ]}
      />
    )

    const text = screen.getByRole('status').textContent ?? ''
    expect(text).to.match(/^2m 41s · ↓ \d+ tokens · Running tools…$/)
    expect(STATUS_WORDS.some(word => text.includes(word))).to.equal(false)
  })

  it('turns red once the stream goes quiet', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    const { container } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[{ type: 'text', text: 'a'.repeat(4000) }]}
      />
    )
    const line = container.querySelector('.ai-assist-status-line')!
    expect(line.classList.contains('is-responding')).to.equal(true)
    expect(line.classList.contains('is-stalled')).to.equal(false)

    act(() => {
      clock.tick(3000)
    })
    expect(line.classList.contains('is-stalled')).to.equal(true)
  })

  it('never calls a running tool a stall', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    const { container } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[
          { type: 'tool_call', call: { id: 'c', name: 'compile', args: {} } },
        ]}
      />
    )
    act(() => {
      clock.tick(10000)
    })
    const line = container.querySelector('.ai-assist-status-line')!
    expect(line.classList.contains('is-tool')).to.equal(true)
    expect(line.classList.contains('is-stalled')).to.equal(false)
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

  it('rolls only the digit that changes when the timer ticks', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started + 12000,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    const { container } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[
          { type: 'tool_call', call: { id: 'c', name: 'compile', args: {} } },
        ]}
      />
    )
    expect(container.querySelector('.ai-assist-roll-in')).to.equal(null)

    act(() => {
      clock.tick(1000)
    })
    const rolling = container.querySelectorAll('.ai-assist-roll-in')
    expect(rolling).to.have.length(1)
    expect(rolling[0].textContent).to.equal('3')
    expect(
      container.querySelector('.ai-assist-roll-out')?.textContent
    ).to.equal('2')
  })

  it('climbs the thinking ladder in place of the word while thinking streams', function () {
    const started = Date.now()
    clock = sinon.useFakeTimers({
      now: started + 49000,
      toFake: ['setInterval', 'clearInterval', 'Date'],
    })

    const { container } = render(
      <AgentStatusLine
        startedAt={started}
        blocks={[
          {
            type: 'thinking',
            thinking: 'planning...',
            startedAt: started + 15000,
          },
        ]}
      />
    )
    expect(
      container.querySelector('.ai-assist-status-verb')?.textContent
    ).to.equal('Thinking some more…')
    expect(screen.getByRole('status').textContent).to.match(
      /^49s · ↓ \d+ tokens · Thinking some more…$/
    )
  })

  it('says "Running tools…" while a tool call is in flight, never flickering transient verbs', function () {
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
    expect(text).to.contain('Running tools…')
  })

  it('says "Running tools…" for search_project too, never flickering search queries', function () {
    render(
      <AgentStatusLine
        startedAt={Date.now()}
        blocks={[
          {
            type: 'tool_call',
            call: {
              id: 'c2',
              name: 'search_project',
              args: { query: '\\label' },
            },
          },
        ]}
      />
    )
    const text = screen.getByRole('status').textContent || ''
    expect(text).to.not.contain('Searching for')
    expect(text).to.contain('Running tools…')
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
        pendingApproval={{
          id: 'c3',
          edit: { path: 'main.tex', oldText: 'a', newText: 'b' },
        }}
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
    expect(
      STATUS_WORDS.some(word => line.textContent?.includes(word))
    ).to.equal(true)
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

  it('keeps the same status word across token updates rather than blinking on every token', function () {
    const started = Date.now()
    const { container, rerender } = render(
      <AgentStatusLine
        startedAt={started}
        isRunning={true}
        blocks={[{ type: 'text', text: 'Hello' }]}
        onWordChange={() => {}}
      />
    )
    const verb = () =>
      container.querySelector('.ai-assist-status-verb')?.textContent
    const initialText = verb()

    // Simulate 5 successive token arrivals with new callback references
    for (let i = 1; i <= 5; i++) {
      rerender(
        <AgentStatusLine
          startedAt={started}
          isRunning={true}
          blocks={[{ type: 'text', text: `Hello world ${i}` }]}
          onWordChange={() => {}}
        />
      )
      // The status word should be identical, never changing per token
      expect(verb()).to.equal(initialText)
    }
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
    expect(formatCompletedStatus('Typesetting…', 67000)).to.equal(
      'Typeset for 1m 7s'
    )
    expect(formatCompletedStatus('Working', 500)).to.equal('Worked for 1s')
  })
})

describe("the activity line stays out of the status line's job", function () {
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
