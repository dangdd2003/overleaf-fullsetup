import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import {
  ConnectorModel,
  ConnectorCredentialModel,
  OAuthStateModel,
} from '../../../app/src/connectors/ConnectorModel.mjs'
import { AiAssistUserSettingsModel } from '../../../app/src/AiAssistUserSettingsModel.mjs'
import chatStore from '../../../app/src/AiAssistChatHistoryStore.mjs'
import checkpointStore from '../../../app/src/AiAssistCheckpointStore.mjs'
import preferencesStore from '../../../app/src/AiAssistPreferencesStore.mjs'
import languageCheckStore from '../../../app/src/AiAssistLanguageCheckStore.mjs'
import {
  removeProjectData,
  removeUserData,
} from '../../../app/src/AiAssistUserCleanup.mjs'

const PROJECT = '0123456789abcdef01234567'
const OTHER_PROJECT = 'fedcba9876543210fedcba98'
const USER = 'abcdef0123456789abcdef01'
const OTHER_USER = '111111111111111111111111'
const turn = text => [{ id: 'u0', role: 'user', text }]
const ENTRY = { edits: [] }

async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false
  )
}

describe('AiAssistUserCleanup', function () {
  let dir
  let origDir
  let stubs

  beforeEach(async function () {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-cleanup-'))
    Settings.aiAssist = Settings.aiAssist || {}
    origDir = Settings.aiAssist.chatHistoryDir
    Settings.aiAssist.chatHistoryDir = dir
    // The Mongo collections are not part of this test
    stubs = [ConnectorModel, ConnectorCredentialModel, OAuthStateModel, AiAssistUserSettingsModel].map(
      model => sinon.stub(model, 'deleteMany').returns({ exec: async () => {} })
    )

    await chatStore.saveChat(PROJECT, USER, 'a', turn('a'))
    await chatStore.saveChat(OTHER_PROJECT, USER, 'b', turn('b'))
    await chatStore.saveChat(PROJECT, OTHER_USER, 'c', turn('c'))
    await checkpointStore.saveCheckpoint(PROJECT, USER, 'a', 'u0', { 'main.tex': { originalContent: 'x' } })
    await checkpointStore.saveCheckpoint(OTHER_PROJECT, USER, 'b', 'u0', { 'main.tex': { originalContent: 'x' } })
    await checkpointStore.saveCheckpoint(PROJECT, OTHER_USER, 'c', 'u0', { 'main.tex': { originalContent: 'x' } })
    await preferencesStore.save(USER, { reasoningEffort: {}, thinking: {} })
    await preferencesStore.save(OTHER_USER, { reasoningEffort: {}, thinking: {} })
    await languageCheckStore.store(PROJECT, [{ key: 'k1', entry: ENTRY }])
    await languageCheckStore.flush(PROJECT)
  })

  afterEach(async function () {
    for (const stub of stubs) stub.restore()
    languageCheckStore.open.clear()
    Settings.aiAssist.chatHistoryDir = origDir
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('removes all of a user\'s stored data, twice without error', async function () {
    await removeUserData(USER)
    await removeUserData(USER)

    expect(await chatStore.listChats(PROJECT, USER)).to.deep.equal([])
    expect(await chatStore.listChats(OTHER_PROJECT, USER)).to.deep.equal([])
    expect(await checkpointStore.getCheckpoint(PROJECT, USER, 'a', 'u0')).to.equal(null)
    expect(await checkpointStore.getCheckpoint(OTHER_PROJECT, USER, 'b', 'u0')).to.equal(null)
    expect(await preferencesStore.get(USER)).to.equal(null)
    expect(stubs[0].calledWith({ user_id: USER })).to.equal(true)
  })

  it('leaves other users\' data alone', async function () {
    await removeUserData(USER)
    expect(await chatStore.listChats(PROJECT, OTHER_USER)).to.have.length(1)
    expect(await checkpointStore.getCheckpoint(PROJECT, OTHER_USER, 'c', 'u0')).to.not.equal(null)
    expect(await preferencesStore.get(OTHER_USER)).to.not.equal(null)
  })

  it('removes a project\'s chats of every user, its checkpoints and language checks', async function () {
    await removeProjectData(PROJECT)
    await removeProjectData(PROJECT)

    expect(await chatStore.listChats(PROJECT, USER)).to.deep.equal([])
    expect(await chatStore.listChats(PROJECT, OTHER_USER)).to.deep.equal([])
    expect(await checkpointStore.getCheckpoint(PROJECT, USER, 'a', 'u0')).to.equal(null)
    expect(await checkpointStore.getCheckpoint(PROJECT, OTHER_USER, 'c', 'u0')).to.equal(null)
    expect(await exists(Path.join(dir, 'language-checks', `${PROJECT}.json`))).to.equal(false)
    // Other projects stay
    expect(await chatStore.listChats(OTHER_PROJECT, USER)).to.have.length(1)
    expect(await checkpointStore.getCheckpoint(OTHER_PROJECT, USER, 'b', 'u0')).to.not.equal(null)
  })

  it('does not bring a removed project\'s language checks back on a later store', async function () {
    await removeProjectData(PROJECT)
    await languageCheckStore.store(PROJECT, [{ key: 'k2', entry: ENTRY }])
    await languageCheckStore.flush(PROJECT)
    const found = await languageCheckStore.lookup(PROJECT, ['k1'])
    expect(found).to.deep.equal({})
  })

  it('rejects ids that are not ObjectId hex', async function () {
    let message = null
    try {
      await removeProjectData('../../etc')
    } catch (err) {
      message = err.message
    }
    expect(message).to.equal('invalid project id')
  })
})
