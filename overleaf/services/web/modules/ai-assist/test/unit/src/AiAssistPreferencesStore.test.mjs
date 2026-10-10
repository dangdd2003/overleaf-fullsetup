import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import store from '../../../app/src/AiAssistPreferencesStore.mjs'

const USER = 'abcdef0123456789abcdef01'

describe('AiAssistPreferencesStore', function () {
  let dir
  let origDir

  beforeEach(async function () {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-prefs-'))
    Settings.aiAssist = Settings.aiAssist || {}
    origDir = Settings.aiAssist.chatHistoryDir
    Settings.aiAssist.chatHistoryDir = dir
  })

  afterEach(async function () {
    Settings.aiAssist.chatHistoryDir = origDir
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns null for a user who never saved preferences', async function () {
    expect(await store.get(USER)).to.equal(null)
  })

  it('saves per user and keeps only levels the provider takes', async function () {
    await store.save(USER, {
      reasoningEffort: { anthropic: 'max', ollama: 'max', bogus: 'high' },
      thinking: { anthropic: true, openai: 'yes' },
    })
    expect(await store.get(USER)).to.deep.equal({
      reasoningEffort: { anthropic: 'max' },
      thinking: { anthropic: true },
    })
    const file = Path.join(dir, 'preferences', `${USER}.json`)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).thinking).to.deep.equal({
      anthropic: true,
    })
  })

  it('keeps the writing tools choices, cleaned', async function () {
    await store.save(USER, {
      reasoningEffort: {},
      thinking: {},
      writingTools: {
        recentLanguages: ['Vietnamese', 42, '', 'x'.repeat(41), 'French'],
        rephrase: { level: 'extreme', style: 'punchy', length: 'longer' },
        showDiff: false,
      },
    })
    expect(await store.get(USER)).to.deep.equal({
      reasoningEffort: {},
      thinking: {},
      writingTools: {
        recentLanguages: ['Vietnamese', 'French'],
        rephrase: { level: 'medium', style: 'punchy', length: null },
        showDiff: false,
      },
    })
  })

  it('leaves writing tools out when none were sent', async function () {
    await store.save(USER, { reasoningEffort: {}, thinking: {} })
    expect(await store.get(USER)).to.deep.equal({
      reasoningEffort: {},
      thinking: {},
    })
  })

  it('keeps the language suggestions choices, cleaned', async function () {
    await store.save(USER, {
      reasoningEffort: {},
      thinking: {},
      languageSuggestions: {
        enabled: true,
        englishVariant: 'en-AU',
        model: 'fast',
        types: 'style',
        blocked: [
          { from: 'data  is', to: 'data are', at: 1 },
          { from: 'plans,', to: 'planning,', at: 3 },
          { from: 'data is', to: 'data are', at: 2 },
          { from: 'x'.repeat(201), to: 'y', at: 4 },
          { from: '', to: '', at: 5 },
          { from: 42, to: 'y', at: 6 },
        ],
      },
    })
    expect(await store.get(USER)).to.deep.equal({
      reasoningEffort: {},
      thinking: {},
      languageSuggestions: {
        enabled: true,
        englishVariant: 'en-US',
        model: 'fast',
        blocked: [
          { from: 'plans,', to: 'planning,', at: 3 },
          { from: 'data is', to: 'data are', at: 2 },
        ],
        types: 'style',
      },
    })
  })

  it('keeps at most 500 blocked suggestions, newest first', async function () {
    const blocked = Array.from({ length: 510 }, (_, i) => ({
      from: `a${i}`,
      to: `b${i}`,
      at: i,
    }))
    await store.save(USER, {
      reasoningEffort: {},
      thinking: {},
      languageSuggestions: { blocked },
    })
    const saved = (await store.get(USER)).languageSuggestions
    expect(saved.blocked).to.have.length(500)
    expect(saved.blocked[0]).to.deep.equal({ from: 'a509', to: 'b509', at: 509 })
    expect(saved).to.include({ enabled: false, englishVariant: 'en-US', model: null, types: 'all' })
  })

  it('keeps the completion mode and delay, cleaned', async function () {
    await store.save(USER, {
      reasoningEffort: {},
      thinking: {},
      inlineSuggestions: {
        emptyLineShortcut: true,
        completionMode: 'automatic',
        completionDelayMs: 500,
        extra: 1,
      },
    })
    expect((await store.get(USER)).inlineSuggestions).to.deep.equal({
      emptyLineShortcut: true,
      completionMode: 'automatic',
      completionDelayMs: 500,
    })
  })

  it('falls back to disabled and 300 ms for unknown values', async function () {
    await store.save(USER, {
      reasoningEffort: {},
      thinking: {},
      inlineSuggestions: {
        emptyLineShortcut: 'yes',
        completionMode: 'always',
        completionDelayMs: 250,
      },
    })
    expect((await store.get(USER)).inlineSuggestions).to.deep.equal({
      emptyLineShortcut: false,
      completionMode: 'disabled',
      completionDelayMs: 300,
    })
  })

  it('turns the old sentence completion switch into the manual mode', async function () {
    // A file saved before the dropdown existed
    const file = Path.join(dir, 'preferences', `${USER}.json`)
    await fs.mkdir(Path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        reasoningEffort: {},
        thinking: {},
        inlineSuggestions: { emptyLineShortcut: false, sentenceCompletion: true },
      })
    )
    expect((await store.get(USER)).inlineSuggestions).to.deep.equal({
      emptyLineShortcut: false,
      completionMode: 'manual',
      completionDelayMs: 300,
    })
  })

  it('leaves inlineSuggestions out when none were sent', async function () {
    await store.save(USER, { reasoningEffort: {}, thinking: {} })
    expect(await store.get(USER)).to.not.have.property('inlineSuggestions')
  })
})
