import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  CompactEntry,
  CompactLedger,
  TranscriptEntry,
  toAgentMessages,
} from '../../../../../frontend/js/features/ai-assist/agent/agent-messages'
import {
  AUTO_COMPACT_MAX_FAILURES,
  formatTokenCount,
  renderCompactionMessage,
  shouldAutoCompact,
  userTurnsSinceAutoCompact,
  userTurnsSinceBoundary,
} from '../../../../../frontend/js/features/ai-assist/agent/context/compaction'
import { computeContextUsage } from '../../../../../frontend/js/features/ai-assist/agent/context/context-usage'
import { estimateTokens } from '../../../../../frontend/js/features/ai-assist/agent/context/budget'
import {
  emptyAgentState,
  reduceAgentEvent,
} from '../../../../../frontend/js/features/ai-assist/agent/agent-state'
import {
  dropRepeatedEntries,
  loadConversation,
  prepareTranscriptForRun,
  saveConversation,
} from '../../../../../frontend/js/features/ai-assist/agent/conversation-store'
import { CompactBoundary } from '../../../../../frontend/js/features/ai-assist/components/agent/compact-boundary'

function ledger(overrides: Partial<CompactLedger> = {}): CompactLedger {
  return {
    userMessages: [{ id: 'u0', text: 'Fix the table' }],
    filesRead: [{ path: 'main.tex', ranges: ['1-80'] }],
    edits: [
      {
        path: 'main.tex',
        startLine: 40,
        endLine: 44,
        oldText: 'a',
        newText: 'b',
        status: 'applied',
      },
    ],
    filesCreated: [],
    compile: { unresolved: [], resolved: [] },
    latex: {
      packages: ['booktabs'],
      macros: [],
      labels: ['tab:results'],
      citeKeys: [],
      unresolvedRefs: [],
    },
    settings: [],
    pdf: { pages: [], notes: [] },
    web: [],
    connectors: [],
    slashCommands: [],
    rejected: [],
    ...overrides,
  }
}

function compactEntry(overrides: Partial<CompactEntry> = {}): CompactEntry {
  return {
    id: 'c4',
    role: 'compact',
    createdAt: Date.UTC(2026, 9, 20),
    trigger: 'manual',
    summary: '### Intent\n- Fix the table',
    ledger: ledger(),
    preTokens: 152000,
    postTokens: 9800,
    summarizedEntries: 2,
    durationMs: 4000,
    retention: { score: 0.96, checked: 25, missing: [], repaired: false },
    ...overrides,
  }
}

const user = (id: string, text: string): TranscriptEntry => ({
  id,
  role: 'user',
  text,
})
const reply = (id: string, text: string): TranscriptEntry => ({
  id,
  role: 'assistant',
  text,
  toolCalls: [],
})

describe('compaction', function () {
  describe('renderCompactionMessage', function () {
    it('renders the block the server sends, summary then ledger', function () {
      const text = renderCompactionMessage(compactEntry())
      expect(text.split('\n')[0]).to.equal(
        '<compacted-conversation trigger="manual" turns="1" date="2026-10-20">'
      )
      expect(text).to.include('## Summary\n### Intent\n- Fix the table')
      expect(text).to.include('## Ledger (exact, extracted by code)')
      expect(text).to.include('### Edits (oldest first)')
      expect(text).to.include('- main.tex 40-44 applied "a" -> "b"')
      expect(text).to.include('- Labels: tab:results')
      expect(text.endsWith('</compacted-conversation>')).to.equal(true)
    })

    it('appends the recently edited excerpts inside the block', function () {
      const text = renderCompactionMessage(
        compactEntry({ excerpts: 'main.tex 30-50:\n\\begin{table}' })
      )
      expect(text).to.include(
        '\n\n## Recently edited excerpts\nmain.tex 30-50:\n\\begin{table}\n</compacted-conversation>'
      )
    })
  })

  describe('toAgentMessages after a boundary', function () {
    it('sends the compaction message, the kept tail, then what followed', function () {
      const transcript: TranscriptEntry[] = [
        user('u0', 'old question'),
        reply('a1', 'old answer'),
        user('u2', 'recent question'),
        reply('a3', 'recent answer'),
        compactEntry({ tailFromId: 'u2' }),
        user('u5', 'next question'),
      ]
      const messages = toAgentMessages(transcript)
      expect(messages.map(m => m.content)).to.deep.equal([
        renderCompactionMessage(transcript[4] as CompactEntry),
        'recent question',
        'recent answer',
        'next question',
      ])
      expect(messages[0].role).to.equal('user')
    })

    it('sends no tail when the boundary kept none', function () {
      const transcript: TranscriptEntry[] = [
        user('u0', 'old question'),
        reply('a1', 'old answer'),
        compactEntry({ id: 'c2' }),
        user('u3', 'next question'),
      ]
      expect(toAgentMessages(transcript).map(m => m.content)).to.deep.equal([
        renderCompactionMessage(transcript[2] as CompactEntry),
        'next question',
      ])
    })

    it('uses only the newest of two boundaries, skipping the older one in its tail', function () {
      const first = compactEntry({ id: 'c2', summary: 'first summary' })
      const second = compactEntry({
        id: 'c5',
        summary: 'second summary',
        tailFromId: 'c2',
      })
      const transcript: TranscriptEntry[] = [
        user('u0', 'q0'),
        reply('a1', 'r1'),
        first,
        user('u3', 'q3'),
        reply('a4', 'r4'),
        second,
        user('u6', 'q6'),
      ]
      const messages = toAgentMessages(transcript)
      expect(messages.map(m => m.content)).to.deep.equal([
        renderCompactionMessage(second),
        'q3',
        'r4',
        'q6',
      ])
    })
  })

  describe('reducer', function () {
    it('tracks the phases and appends the boundary when it lands', function () {
      let state = emptyAgentState([user('u0', 'q'), reply('a1', 'r')])
      state = { ...state, running: true }
      state = reduceAgentEvent(state, { type: 'compactStarted', trigger: 'auto' })
      expect(state.compacting).to.deep.equal({ trigger: 'auto', phase: 'masking' })
      state = reduceAgentEvent(state, {
        type: 'compactProgress',
        phase: 'summarizing',
        chunk: 1,
        chunks: 2,
      })
      expect(state.compacting).to.deep.equal({
        trigger: 'auto',
        phase: 'summarizing',
        chunk: 1,
        chunks: 2,
      })
      const entry = compactEntry({ id: 'c2' })
      state = reduceAgentEvent(state, { type: 'compactFinished', entry })
      expect(state.compacting).to.equal(null)
      expect(state.transcript.at(-1)).to.equal(entry)
      // A replayed stream does not add it twice
      state = reduceAgentEvent(state, { type: 'compactFinished', entry })
      expect(state.transcript.filter(e => e.role === 'compact')).to.have.length(1)
      state = reduceAgentEvent(state, { type: 'turnFinished', reason: 'stop' })
      expect(state.running).to.equal(false)
    })

    it('puts the boundary above a message queued behind the compaction', function () {
      let state = emptyAgentState([
        user('u0', 'q'),
        reply('a1', 'r'),
        { id: 'q9', role: 'user', text: 'waiting', pending: true },
      ])
      state = reduceAgentEvent(state, {
        type: 'compactFinished',
        entry: compactEntry({ id: 'c2' }),
      })
      expect(state.transcript.map(e => e.id)).to.deep.equal([
        'u0',
        'a1',
        'c2',
        'q9',
      ])
    })

    it('clears the compaction on a failure, keeping the error', function () {
      let state = emptyAgentState([user('u0', 'q')])
      state = reduceAgentEvent(state, { type: 'compactStarted', trigger: 'manual' })
      state = reduceAgentEvent(state, {
        type: 'error',
        code: 'compactNothing',
        message: 'Nothing to gain',
      })
      expect(state.compacting).to.equal(null)
      expect(state.error?.code).to.equal('compactNothing')
    })
  })

  describe('shouldAutoCompact', function () {
    const settings = { enabled: true }
    const ready = {
      usedTokens: 170000,
      autoCompactAt: 167000,
      userTurnsSinceBoundary: 3,
      consecutiveFailures: 0,
      userTurnsSincePreviousAuto: null,
    }

    it('compacts at or above the auto-compact threshold', function () {
      expect(shouldAutoCompact(settings, ready).compact).to.equal(true)
      expect(
        shouldAutoCompact(settings, { ...ready, usedTokens: 167000 }).compact
      ).to.equal(true)
    })

    it('waits below the threshold, or when auto is off', function () {
      expect(
        shouldAutoCompact(settings, { ...ready, usedTokens: 166999 })
      ).to.deep.equal({ compact: false, reason: 'belowThreshold' })
      expect(
        shouldAutoCompact({ ...settings, enabled: false }, ready).reason
      ).to.equal('disabled')
    })

    it('needs two user turns since the last boundary', function () {
      expect(
        shouldAutoCompact(settings, { ...ready, userTurnsSinceBoundary: 1 })
          .reason
      ).to.equal('tooFewTurns')
    })

    it('stops after three failures in a row (circuit breaker)', function () {
      expect(
        shouldAutoCompact(settings, {
          ...ready,
          consecutiveFailures: AUTO_COMPACT_MAX_FAILURES - 1,
        }).compact
      ).to.equal(true)
      expect(
        shouldAutoCompact(settings, {
          ...ready,
          consecutiveFailures: AUTO_COMPACT_MAX_FAILURES,
        }).reason
      ).to.equal('circuitBreaker')
    })

    it('skips a compaction within two user turns of the last (thrash guard)', function () {
      expect(
        shouldAutoCompact(settings, { ...ready, userTurnsSincePreviousAuto: 1 })
          .reason
      ).to.equal('thrashGuard')
      expect(
        shouldAutoCompact(settings, { ...ready, userTurnsSincePreviousAuto: 2 })
          .compact
      ).to.equal(true)
    })

    it('treats a server auto compaction as a thrash guard attempt', function () {
      // The panel passes the smaller of its own attempts and the server's
      // automatic boundaries; one turn after the server's boundary waits.
      const transcript = [
        user('u0', 'a'),
        user('u1', 'b'),
        compactEntry({ id: 'c1', trigger: 'auto' }),
        user('u2', 'c'),
      ]
      expect(userTurnsSinceAutoCompact(transcript)).to.equal(1)
      expect(
        shouldAutoCompact(settings, {
          ...ready,
          userTurnsSinceBoundary: 1,
          userTurnsSincePreviousAuto: userTurnsSinceAutoCompact(transcript),
        }).reason
      ).to.equal('tooFewTurns')
      expect(
        shouldAutoCompact(settings, {
          ...ready,
          userTurnsSincePreviousAuto: 1,
        }).reason
      ).to.equal('thrashGuard')
    })

    it('reports no automatic boundary when the chat only has manual ones', function () {
      expect(
        userTurnsSinceAutoCompact([
          user('u0', 'a'),
          compactEntry({ id: 'c1', trigger: 'manual' }),
        ])
      ).to.equal(null)
    })

    it('counts the sent user turns since the newest boundary', function () {
      expect(
        userTurnsSinceBoundary([
          user('u0', 'a'),
          compactEntry({ id: 'c1' }),
          user('u2', 'b'),
          reply('a3', 'r'),
          user('u4', 'c'),
          { id: 'q5', role: 'user', text: 'd', pending: true },
        ])
      ).to.equal(2)
    })
  })

  describe('context usage after a boundary', function () {
    const LIMITS = { contextWindow: 200000, maxOutputTokens: 32000 }

    it('ignores usage from before the boundary and counts what is still sent', function () {
      const boundary = compactEntry({ id: 'c3', tailFromId: 'u2' })
      const transcript: TranscriptEntry[] = [
        user('u0', 'x'.repeat(40000)),
        {
          ...(reply('a1', 'old') as any),
          usage: { inputTokens: 150000, outputTokens: 100 },
        },
        user('u2', 'kept question'),
        boundary,
        user('u4', 'next'),
      ]
      const snapshot = computeContextUsage({ transcript, limits: LIMITS })
      expect(snapshot.exact).to.equal(false)
      expect(snapshot.usedTokens).to.equal(
        estimateTokens(renderCompactionMessage(boundary)) +
          estimateTokens('kept question') +
          estimateTokens('next')
      )
    })

    it('keeps the fixed rows of the last request and shows the rest as since last update', function () {
      const boundary = compactEntry({ id: 'c2' })
      const transcript: TranscriptEntry[] = [
        user('u0', 'q'),
        {
          ...(reply('a1', 'r') as any),
          contextBreakdown: {
            systemPrompt: 3000,
            builtinTools: 2000,
            userMessages: 90000,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
        boundary,
      ]
      const snapshot = computeContextUsage({ transcript, limits: LIMITS })
      const tokens = (id: string) =>
        snapshot.categories.find(c => c.id === id)?.tokens
      expect(tokens('systemPrompt')).to.equal(3000)
      expect(tokens('messages')).to.equal(0)
      expect(tokens('sinceLastUpdate')).to.equal(
        estimateTokens(renderCompactionMessage(boundary))
      )
    })
  })

  describe('conversation store', function () {
    beforeEach(function () {
      customLocalStorage.clear()
    })

    it('keeps compact entries as they are', function () {
      const boundary = compactEntry({ id: 'c2' })
      const transcript = [user('u0', 'q'), reply('a1', 'r'), boundary]
      saveConversation('project1', 'chat1', transcript)
      expect(loadConversation('project1', 'chat1')[2]).to.deep.equal(boundary)
      expect(prepareTranscriptForRun(transcript, 10)).to.deep.include(boundary)
    })

    it('drops a boundary repeated right after itself', function () {
      const boundary = compactEntry({ id: 'c2' })
      expect(
        dropRepeatedEntries([user('u0', 'q'), boundary, { ...boundary }])
      ).to.have.length(2)
    })
  })

  describe('CompactBoundary', function () {
    it('is one collapsed line of numbers that expands to the summary and ledger', function () {
      render(<CompactBoundary entry={compactEntry({ trigger: 'auto' })} />)
      const header = screen.getByRole('button', {
        name: 'Conversation compacted · 152k → 9.8k tokens · 96% retained · auto',
      })
      expect(header.getAttribute('aria-expanded')).to.equal('false')
      expect(screen.queryByText('Fix the table', { selector: 'li' })).to.equal(
        null
      )
      fireEvent.click(header)
      expect(header.getAttribute('aria-expanded')).to.equal('true')
      expect(screen.getByText('Intent')).to.exist
      expect(screen.getByText('Ledger (exact, extracted by code)')).to.exist
    })

    it('says when the summary fell back to the deterministic one', function () {
      render(<CompactBoundary entry={compactEntry({ fallback: true })} />)
      expect(screen.getByRole('button').textContent).to.include('· fallback')
    })

    it('formats token counts like the meter', function () {
      expect(formatTokenCount(152000)).to.equal('152k')
      expect(formatTokenCount(9800)).to.equal('9.8k')
      expect(formatTokenCount(1_200_000)).to.equal('1.2M')
      expect(formatTokenCount(512)).to.equal('512')
    })
  })
})
