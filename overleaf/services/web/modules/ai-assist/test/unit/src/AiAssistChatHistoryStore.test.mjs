import { expect } from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import store, {
  sanitizeChatTitle,
  fallbackTitleFor,
  reorganizePromptToTitle,
  titleFor,
} from '../../../app/src/AiAssistChatHistoryStore.mjs'
import { generateChatTitle } from '../../../app/src/AiAssistChatTitler.mjs'

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

    expect(summary).to.include({ id: 'chat1', title: 'Fix My Table', messageCount: 1 })
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
    expect((await store.getChat(PROJECT, USER, 'old')).title).to.equal('A')

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

  it('sanitizes AI-generated chat titles', function () {
    expect(sanitizeChatTitle('  "Title: Fix LaTeX Bibliography."  ')).to.equal(
      'Fix LaTeX Bibliography'
    )
    expect(sanitizeChatTitle('**Chat Topic: Quantum Key Distribution**\nSome other line')).to.equal(
      'Quantum Key Distribution'
    )
    expect(sanitizeChatTitle('`Add Author Affiliations:`')).to.equal('Add Author Affiliations')
  })

  it('reorganizes user prompt into a concise title like Claude AI', function () {
    expect(
      reorganizePromptToTitle(
        'Edit main.tex to tighten passive phrasing and fix grammar with minimal localized changes'
      )
    ).to.equal('Tighten Passive Phrasing in main.tex')

    expect(
      reorganizePromptToTitle(
        'Scan this project for unsupported statements, claims, or assertions that lack citations'
      )
    ).to.equal('Scan for Unsupported Statements')

    expect(
      reorganizePromptToTitle(
        'Inspect the compile log and resolve the 15 compile-blocking errors'
      )
    ).to.equal('Resolve Compile Errors')

    expect(
      reorganizePromptToTitle(
        'Draft a concise 200-word abstract in the abstract environment of main.tex based on structure'
      )
    ).to.equal('Draft Abstract in main.tex')
  })

  it('preserves existing AI-generated title across subsequent saves', async function () {
    const chat = await store.saveChat(PROJECT, USER, 'chat_ai', [
      { role: 'user', text: 'first long prompt that could be anything' },
    ])
    expect(chat.id).to.equal('chat_ai')

    // AI generated or custom rename
    await store.saveChatTitle(PROJECT, USER, 'chat_ai', 'Smart Generated Title')

    // Later turn saves chat again
    const updated = await store.saveChat(PROJECT, USER, 'chat_ai', [
      { role: 'user', text: 'first long prompt that could be anything' },
      { role: 'assistant', text: 'reply' },
      { role: 'user', text: 'second message' },
    ])

    expect(updated.title).to.equal('Smart Generated Title')
    expect(updated.titleGenerated).to.be.true
  })

  it('generates chat title using provider client', async function () {
    const mockClient = {
      async *streamChat() {
        yield { type: 'text', text: 'Optimized ' }
        yield { type: 'text', text: 'Agent Harness' }
      },
    }

    const title = await generateChatTitle({
      client: mockClient,
      firstMessageText: 'Can you please reoptimize the agent harness?',
    })

    expect(title).to.equal('Optimized Agent Harness')
  })
})
