import { expect } from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import store from '../../../app/src/AiAssistChatHistoryStore.mjs'

const PROJECT = '0123456789abcdef01234567'
const USER = 'abcdef0123456789abcdef01'

describe('AiAssistChatHistoryStore', function () {
  let dir
  let origDir

  beforeEach(async function () {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-chats-'))
    Settings.aiAssist = Settings.aiAssist || {}
    origDir = Settings.aiAssist.chatHistoryDir
    Settings.aiAssist.chatHistoryDir = dir
  })

  afterEach(async function () {
    Settings.aiAssist.chatHistoryDir = origDir
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes one JSON file per chat under <projectId>-<userId>', async function () {
    const transcript = [{ id: 'u0', role: 'user', text: 'Fix my table' }]
    const summary = await store.saveChat(PROJECT, USER, 'chat1', transcript)

    expect(summary).to.include({ id: 'chat1', title: 'Fix my table', messageCount: 1 })
    const raw = JSON.parse(
      await fs.readFile(Path.join(dir, `${PROJECT}-${USER}`, 'chat1.json'), 'utf8')
    )
    expect(raw.transcript).to.deep.equal(transcript)
  })

  it('lists newest first, loads and deletes chats', async function () {
    await store.saveChat(PROJECT, USER, 'old', [{ id: 'u0', role: 'user', text: 'a' }])
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.saveChat(PROJECT, USER, 'new', [{ id: 'u0', role: 'user', text: 'b' }])

    expect((await store.listChats(PROJECT, USER)).map(c => c.id)).to.deep.equal(['new', 'old'])
    expect((await store.getChat(PROJECT, USER, 'old')).title).to.equal('a')

    await store.deleteChat(PROJECT, USER, 'old')
    expect(await store.getChat(PROJECT, USER, 'old')).to.equal(null)
  })

  it('keeps createdAt across saves and rejects path-like chat ids', async function () {
    const first = await store.saveChat(PROJECT, USER, 'c', [])
    const second = await store.saveChat(PROJECT, USER, 'c', [])
    expect(second.createdAt).to.equal(first.createdAt)

    try {
      await store.getChat(PROJECT, USER, '../escape')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.equal('invalid chat id')
    }
  })
})
