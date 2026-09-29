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
})
