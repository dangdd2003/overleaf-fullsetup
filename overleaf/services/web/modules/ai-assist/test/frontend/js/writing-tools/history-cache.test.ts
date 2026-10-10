import { expect } from 'chai'
import customSessionStorage from '@/infrastructure/session-storage'
import {
  clearSelectionHistory,
  consumeMenuRequested,
  getSelectionHistory,
  getTexGptHistory,
  getWritingToolHistory,
  hasSelectionHistory,
  normalizeSelectionKey,
  saveTexGptHistory,
  saveWritingToolHistory,
  signalMenuRequested,
} from '../../../../frontend/js/features/ai-assist/writing-tools/history-cache'

describe('writing tools: history cache', function () {
  beforeEach(function () {
    clearSelectionHistory()
    try {
      customSessionStorage.clear()
    } catch {
      // ignore
    }
  })

  it('normalizes selection keys by trimming whitespace', function () {
    expect(normalizeSelectionKey('  hello world  ')).to.equal('hello world')
    expect(normalizeSelectionKey('\n\tSample text.\n')).to.equal('Sample text.')
    expect(normalizeSelectionKey('   ')).to.equal('')
  })

  it('saves and retrieves writing tool history for selected text', function () {
    const originalText = 'This is the original sentence.'
    saveWritingToolHistory({
      kind: 'writing-tool',
      originalText,
      action: 'rephrase',
      history: {
        versions: [
          {
            text: 'This is the rephrased sentence.',
            warnings: [],
            unit: 'phrase',
          },
        ],
        index: 0,
      },
      synonyms: [],
      rephraseSettings: { level: 'medium', style: 'scientific', length: null },
      prompt: '',
      durationMs: 320,
      kept: [],
      timestamp: Date.now(),
    })

    expect(hasSelectionHistory(originalText)).to.be.true
    expect(hasSelectionHistory('  This is the original sentence.  ')).to.be.true

    const cached = getWritingToolHistory(originalText, 'rephrase')
    expect(cached).to.not.be.null
    expect(cached?.kind).to.equal('writing-tool')
    expect(cached?.action).to.equal('rephrase')
    expect(cached?.history.versions).to.have.lengthOf(1)
    expect(cached?.history.versions[0].text).to.equal(
      'This is the rephrased sentence.'
    )
    expect(cached?.durationMs).to.equal(320)
  })

  it('allows user to continue at their last job when updated', function () {
    const originalText = 'Section 1 introduction.'
    // First run: rephrase
    saveWritingToolHistory({
      kind: 'writing-tool',
      originalText,
      action: 'rephrase',
      history: {
        versions: [{ text: 'Rephrased v1', warnings: [], unit: 'phrase' }],
        index: 0,
      },
      synonyms: [],
      durationMs: 200,
      timestamp: 1000,
    })

    // Second run: user shortened it
    saveWritingToolHistory({
      kind: 'writing-tool',
      originalText,
      action: 'shorten',
      history: {
        versions: [
          { text: 'Shortened v1', warnings: [], unit: 'phrase' },
          { text: 'Shortened v2', warnings: [], unit: 'phrase' },
        ],
        index: 1,
      },
      synonyms: [],
      durationMs: 150,
      timestamp: 2000,
    })

    const cached = getSelectionHistory(originalText)
    expect(cached).to.not.be.null
    expect(cached?.kind).to.equal('writing-tool')
    if (cached?.kind === 'writing-tool') {
      expect(cached.action).to.equal('shorten')
      expect(cached.history.versions).to.have.lengthOf(2)
      expect(cached.history.index).to.equal(1)
      expect(cached.history.versions[1].text).to.equal('Shortened v2')
    }
  })

  it('saves and retrieves TeXGPT prompt generations on selections', function () {
    const originalText = 'Consider the following theorem.'
    saveTexGptHistory({
      kind: 'texgpt',
      originalText,
      run: {
        title: 'make this rigorous',
        prompt: 'make this rigorous',
        generator: null,
      },
      versions: [
        {
          kind: 'latex',
          text: '\\begin{theorem}...\n\\end{theorem}',
          packages: ['amsmath'],
          warnings: [],
          raw: '\\begin{theorem}...\n\\end{theorem}',
          messages: [],
        },
      ],
      index: 0,
      choice: 0,
      durationMs: 450,
      showDiff: true,
      addPackages: true,
      timestamp: Date.now(),
    })

    const cached = getTexGptHistory(originalText)
    expect(cached).to.not.be.null
    expect(cached?.kind).to.equal('texgpt')
    expect(cached?.run.prompt).to.equal('make this rigorous')
    expect(cached?.versions[0].kind).to.equal('latex')
    if (cached?.versions[0].kind === 'latex') {
      expect(cached.versions[0].packages).to.deep.equal(['amsmath'])
    }
  })

  it('manages signalMenuRequested flag correctly', function () {
    expect(consumeMenuRequested()).to.be.false
    signalMenuRequested()
    expect(consumeMenuRequested()).to.be.true
    expect(consumeMenuRequested()).to.be.false
  })

  it('returns null for ungenerated text', function () {
    expect(getSelectionHistory('Never generated text')).to.be.null
    expect(hasSelectionHistory('Never generated text')).to.be.false
  })
})
