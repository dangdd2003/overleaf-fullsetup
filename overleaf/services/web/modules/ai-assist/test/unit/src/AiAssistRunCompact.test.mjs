import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import {
  AiAssistRunManager,
  latestContextTrim,
  toAgentMessages,
} from '../../../app/src/AiAssistRunManager.mjs'
import { AiAssistRunController } from '../../../app/src/AiAssistRunController.mjs'
import { AiAssistChatHistoryController } from '../../../app/src/AiAssistChatHistoryController.mjs'
import store, {
  compactEntryProblem,
  countSteps,
  hydrateTranscript,
} from '../../../app/src/AiAssistChatHistoryStore.mjs'
import { renderCompactionMessage } from '../../../app/src/AiAssistCompaction.mjs'

const PROJECT = '0123456789abcdef01234567'
const USER = 'abcdef0123456789abcdef01'

const userEntry = (id, text) => ({ id, role: 'user', text })
const replyEntry = (id, text, extra = {}) => ({
  id,
  role: 'assistant',
  text,
  toolCalls: [],
  ...extra,
})
function compactEntry(id, extra = {}) {
  return {
    id,
    role: 'compact',
    createdAt: 1700000000000,
    trigger: 'manual',
    summary: '### Intent\n- Fix the table',
    ledger: { userMessages: [{ id: 'u0', text: 'Fix the table' }] },
    preTokens: 900,
    postTokens: 200,
    summarizedEntries: 2,
    durationMs: 10,
    retention: { score: 1, checked: 0, missing: [], repaired: false },
    ...extra,
  }
}

describe('AiAssist compaction on the server', function () {
  describe('toAgentMessages after a compaction', function () {
    it('starts from the compaction, then the entries after it, without a tail', function () {
      const compact = compactEntry('c2')
      const transcript = [
        userEntry('u0', 'old question'),
        replyEntry('a0', 'old answer'),
        compact,
        userEntry('u3', 'new question'),
        replyEntry('a3', 'new answer'),
      ]
      expect(toAgentMessages(transcript)).to.deep.equal([
        { role: 'user', content: renderCompactionMessage(compact) },
        { role: 'user', content: 'new question' },
        { role: 'assistant', content: 'new answer' },
      ])
    })

    it('sends the kept tail verbatim between the compaction and what follows', function () {
      const compact = compactEntry('c4', { tailFromId: 'u2' })
      const transcript = [
        userEntry('u0', 'old question'),
        replyEntry('a0', 'old answer'),
        userEntry('u2', 'last question'),
        replyEntry('a2', 'last answer'),
        compact,
        userEntry('u5', 'after'),
        replyEntry('a5', 'after answer'),
      ]
      expect(toAgentMessages(transcript)).to.deep.equal([
        { role: 'user', content: renderCompactionMessage(compact) },
        { role: 'user', content: 'last question' },
        { role: 'assistant', content: 'last answer' },
        { role: 'user', content: 'after' },
        { role: 'assistant', content: 'after answer' },
      ])
    })

    it('treats an unknown tail id as no tail', function () {
      const compact = compactEntry('c2', { tailFromId: 'gone' })
      const messages = toAgentMessages([
        userEntry('u0', 'old'),
        compact,
        userEntry('u2', 'new'),
      ])
      expect(messages.map(m => m.content)).to.deep.equal([
        renderCompactionMessage(compact),
        'new',
      ])
    })

    it('lets the newest of two compactions win', function () {
      const first = compactEntry('c2')
      const second = compactEntry('c5', {
        tailFromId: 'u3',
        summary: '### Intent\n- Second summary',
      })
      const messages = toAgentMessages([
        userEntry('u0', 'one'),
        replyEntry('a0', 'one answer'),
        first,
        userEntry('u3', 'two'),
        replyEntry('a3', 'two answer'),
        second,
        userEntry('u6', 'three'),
      ])
      expect(messages).to.deep.equal([
        { role: 'user', content: renderCompactionMessage(second) },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'two answer' },
        { role: 'user', content: 'three' },
      ])
      expect(messages[0].content).to.include('Second summary')
    })

    it('skips an older compaction met inside a kept tail', function () {
      const compact = compactEntry('c4', { tailFromId: 'u0' })
      const messages = toAgentMessages([
        userEntry('u0', 'kept'),
        compactEntry('c1'),
        userEntry('u2', 'after older'),
        compact,
        userEntry('u5', 'newest'),
      ])
      expect(messages.map(m => m.content)).to.deep.equal([
        renderCompactionMessage(compact),
        'kept',
        'after older',
        'newest',
      ])
    })
  })

  describe('latestContextTrim after a compaction', function () {
    const trim = { total: 9, anchor: 'x', dropped: 2, elided: [] }

    it('ignores a trim recorded before the newest compaction', function () {
      expect(
        latestContextTrim([
          userEntry('u0', 'a'),
          replyEntry('a0', 'b', { contextTrim: trim }),
          compactEntry('c2'),
          userEntry('u3', 'c'),
        ]),
      ).to.be.null
    })

    it('returns a trim recorded after the newest compaction', function () {
      const later = { ...trim, total: 3 }
      expect(
        latestContextTrim([
          replyEntry('a0', 'b', { contextTrim: trim }),
          compactEntry('c1'),
          userEntry('u2', 'c'),
          replyEntry('a2', 'd', { contextTrim: later }),
        ]),
      ).to.deep.equal(later)
    })
  })

  describe('chat history with compaction entries', function () {
    let dir
    let origDir

    beforeEach(async function () {
      dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-compact-'))
      origDir = Settings.aiAssist.chatHistoryDir
      Settings.aiAssist.chatHistoryDir = dir
    })

    afterEach(async function () {
      Settings.aiAssist.chatHistoryDir = origDir
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('does not count compaction entries as steps', function () {
      expect(
        countSteps([
          userEntry('u0', 'a'),
          replyEntry('a0', 'b', { durationMs: 40 }),
          compactEntry('c2'),
          userEntry('u3', 'c'),
        ]),
      ).to.equal(3)
    })

    it('hydrates a truncated panel copy back to the stored compaction and its prefix', function () {
      const stored = [
        userEntry('u0', 'old'),
        compactEntry('c1'),
        userEntry('u2', 'new'),
        replyEntry('a3', 'answer'),
      ]
      const panel = stored.slice(1)
      expect(hydrateTranscript(panel, stored)).to.deep.equal(stored)
    })

    it('keeps a compaction entry that the panel copy already has', function () {
      const stored = [userEntry('u0', 'old'), compactEntry('c1')]
      expect(hydrateTranscript([...stored], stored)).to.deep.equal(stored)
    })

    it('reads back a saved compaction entry unchanged', async function () {
      const entry = compactEntry('c2', { instructions: 'keep the bib' })
      const transcript = [
        userEntry('u0', 'old'),
        replyEntry('a0', 'answer'),
        entry,
        userEntry('u3', 'next'),
      ]
      await store.saveChat(PROJECT, USER, 'chatc', transcript)
      const chat = await store.getChat(PROJECT, USER, 'chatc')
      expect(chat.transcript[2]).to.deep.equal(entry)
      expect(chat.stats.totalSteps).to.equal(3)
    })

    it('validates the fields of a compaction entry', function () {
      expect(compactEntryProblem(compactEntry('c1'))).to.be.null
      expect(compactEntryProblem(compactEntry('c1', { trigger: 'soon' }))).to.be.a(
        'string',
      )
      expect(compactEntryProblem(compactEntry('c1', { summary: undefined }))).to.be.a(
        'string',
      )
      expect(
        compactEntryProblem(compactEntry('c1', { summary: 'x'.repeat(60_001) })),
      ).to.be.a('string')
      expect(
        compactEntryProblem(
          compactEntry('c1', { ledger: { big: 'x'.repeat(200_001) } }),
        ),
      ).to.be.a('string')
      expect(compactEntryProblem(compactEntry('c1', { ledger: [] }))).to.be.a(
        'string',
      )
      expect(compactEntryProblem(compactEntry(''))).to.be.a('string')
    })
  })

  describe('chat history save controller', function () {
    it('refuses a saved compaction entry that is too large', async function () {
      const mockStore = { saveChat: sinon.stub().resolves({}) }
      const controller = new AiAssistChatHistoryController({
        store: mockStore,
        clientFactory: () => ({}),
        checkpointStore: {},
      })
      const res = { status: sinon.stub().returnsThis(), json: sinon.stub() }
      await controller.save(
        {
          params: { Project_id: PROJECT, chatId: 'chat1' },
          session: { user: { _id: USER } },
          body: {
            transcript: [compactEntry('c1', { summary: 'x'.repeat(60_001) })],
          },
        },
        res,
      )
      expect(res.status.calledWith(400)).to.be.true
      expect(mockStore.saveChat.called).to.be.false
    })
  })

  describe('run controller validation for kind compact', function () {
    let controller
    let mockManager
    let res

    const body = extra => ({
      transcript: [userEntry('u0', 'hi'), replyEntry('a0', 'hello')],
      providerSettings: { type: 'openai', apiKey: 'key', model: 'gpt-4o' },
      chatId: 'chat1',
      kind: 'compact',
      ...extra,
    })
    const req = extra => ({
      params: { Project_id: PROJECT },
      session: { user: { _id: USER } },
      body: body(extra),
    })

    beforeEach(function () {
      mockManager = {
        startRun: sinon.stub().resolves(),
        hasActiveRunForChat: sinon.stub().returns(false),
      }
      controller = new AiAssistRunController({
        manager: mockManager,
        store: {},
        subscriber: {},
        authorization: {},
      })
      res = { status: sinon.stub().returnsThis(), json: sinon.stub() }
    })

    it('starts a compaction run with its instructions and trigger', async function () {
      await controller.createRun(
        req({ instructions: '  keep the bib  ', trigger: 'auto' }),
        res,
      )
      expect(res.json.calledOnce).to.be.true
      expect(mockManager.startRun.calledOnce).to.be.true
      const args = mockManager.startRun.firstCall.args[0]
      expect(args.kind).to.equal('compact')
      expect(args.compaction).to.deep.equal({
        instructions: 'keep the bib',
        trigger: 'auto',
      })
    })

    it('defaults to a manual trigger with no instructions', async function () {
      await controller.createRun(req(), res)
      const args = mockManager.startRun.firstCall.args[0]
      expect(args.compaction).to.deep.equal({ instructions: '', trigger: 'manual' })
    })

    it('keeps a chat turn as a chat turn when no kind is sent', async function () {
      await controller.createRun(
        { ...req(), body: { ...body(), kind: undefined } },
        res,
      )
      const args = mockManager.startRun.firstCall.args[0]
      expect(args.kind).to.equal('chat')
      expect(args.compaction).to.be.null
    })

    it('rejects an unknown kind', async function () {
      await controller.createRun(req({ kind: 'summarize' }), res)
      expect(res.status.calledWith(400)).to.be.true
      expect(mockManager.startRun.called).to.be.false
    })

    it('rejects an unknown trigger', async function () {
      await controller.createRun(req({ trigger: 'soon' }), res)
      expect(res.status.calledWith(400)).to.be.true
      expect(mockManager.startRun.called).to.be.false
    })

    it('rejects instructions over 2000 characters', async function () {
      await controller.createRun(req({ instructions: 'x'.repeat(2001) }), res)
      expect(res.status.calledWith(400)).to.be.true
      expect(mockManager.startRun.called).to.be.false
    })

    it('refuses a compaction while the chat is already running', async function () {
      mockManager.hasActiveRunForChat.returns(true)
      await controller.createRun(req(), res)
      expect(res.status.calledWith(409)).to.be.true
      expect(res.json.firstCall.args[0]).to.include({ code: 'chatBusy' })
      expect(mockManager.startRun.called).to.be.false
    })

    it('rejects a transcript with a malformed compaction entry', async function () {
      await controller.createRun(
        req({ transcript: [compactEntry('c1', { trigger: 'x' })], kind: 'chat' }),
        res,
      )
      expect(res.status.calledWith(400)).to.be.true
      expect(mockManager.startRun.called).to.be.false
    })
  })

  describe('compaction run', function () {
    let manager
    let mockStore
    let mockTools
    let mockClient
    let chatHistoryStore
    let compactor
    let clientFactory
    let transcript

    const events = () =>
      mockStore.appendEvent.getCalls().map(call => call.args[1])
    const types = () => events().map(event => event.type)

    beforeEach(function () {
      mockStore = {
        createRun: sinon.stub().resolves(),
        appendEvent: sinon.stub().resolves(1),
        updateStatus: sinon.stub().resolves(),
        touchHeartbeat: sinon.stub().resolves(),
        getRun: sinon.stub().resolves({ status: 'running' }),
      }
      mockTools = {
        execute: sinon.stub().resolves({ content: 'x' }),
      }
      mockClient = { streamChat: sinon.stub() }
      clientFactory = sinon.stub().returns(mockClient)
      chatHistoryStore = {
        saveChat: sinon.stub().resolves({}),
        getChat: sinon.stub().resolves(null),
        saveChatTitle: sinon.stub().resolves(null),
      }
      compactor = sinon.stub().callsFake(async ({ onProgress }) => {
        await onProgress({ phase: 'masking' })
        await onProgress({ phase: 'summarizing', chunk: 1, chunks: 1 })
        return {
          summary: '### Intent\n- Fix the table',
          ledger: { userMessages: [{ id: 'u0', text: 'Fix the table' }] },
          tailFromId: 'u0',
          preTokens: 900,
          postTokens: 200,
          summarizedEntries: 1,
          durationMs: 12,
          retention: { score: 1, checked: 1, missing: [], repaired: false },
        }
      })
      manager = new AiAssistRunManager({
        store: mockStore,
        tools: mockTools,
        clientFactory,
        chatHistoryStore,
        compactor,
      })
      transcript = [
        userEntry('u0', 'Fix the table'),
        replyEntry('a0', 'Done'),
        userEntry('u2', 'Thanks'),
        replyEntry('a2', 'Welcome'),
      ]
    })

    const start = (extra = {}) =>
      manager.startRun({
        runId: 'run_compact',
        projectId: PROJECT,
        userId: USER,
        chatId: 'chat1',
        transcript,
        providerSettings: { type: 'openai', apiKey: 'key', model: 'gpt-4o' },
        mode: 'manual',
        kind: 'compact',
        compaction: { instructions: 'keep the bib', trigger: 'manual' },
        ...extra,
      })

    it('emits the compaction events in order and appends the entry', async function () {
      await start()
      expect(types()).to.deep.equal([
        'compactStarted',
        'compactProgress',
        'compactProgress',
        'compactFinished',
        'turnFinished',
      ])
      expect(events()[0]).to.deep.equal({ type: 'compactStarted', trigger: 'manual' })
      expect(events()[1]).to.deep.equal({ type: 'compactProgress', phase: 'masking' })
      expect(events()[2]).to.deep.equal({
        type: 'compactProgress',
        phase: 'summarizing',
        chunk: 1,
        chunks: 1,
      })
      const finished = events()[3]
      expect(finished.entry).to.include({
        id: 'c4',
        role: 'compact',
        trigger: 'manual',
        instructions: 'keep the bib',
        summary: '### Intent\n- Fix the table',
        tailFromId: 'u0',
      })
      expect(finished.entry.createdAt).to.be.a('number')
      expect(events()[4]).to.deep.equal({ type: 'turnFinished', reason: 'stop' })
      expect(mockStore.updateStatus.lastCall.args).to.deep.equal(['run_compact', 'done'])
    })

    it('persists the transcript with the compaction entry appended', async function () {
      await start()
      const saved = chatHistoryStore.saveChat.lastCall.args[3]
      expect(saved).to.have.length(5)
      expect(saved[4]).to.include({ role: 'compact', id: 'c4' })
      expect(saved.slice(0, 4)).to.deep.equal(transcript)
    })

    it('runs the compactor with the chat provider, no thinking, and the run signal', async function () {
      await start()
      const opts = compactor.firstCall.args[0]
      expect(opts.client).to.equal(mockClient)
      expect(opts.transcript).to.deep.equal(transcript)
      expect(opts.instructions).to.equal('keep the bib')
      expect(opts.trigger).to.equal('manual')
      expect(opts.providerType).to.equal('openai')
      expect(opts.model).to.equal('gpt-4o')
      expect(opts.signal).to.be.an.instanceOf(AbortSignal)
      expect(opts.limits).to.have.property('contextWindow')
      expect(clientFactory.lastCall.args[0]).to.include({
        reasoningEffort: undefined,
        thinking: undefined,
      })
    })

    it('uses no tools and no title', async function () {
      await start()
      expect(mockTools.execute.called).to.be.false
      expect(chatHistoryStore.saveChatTitle.called).to.be.false
    })

    it('reads an excerpt of the live document for the compactor', async function () {
      mockTools._resolveDoc = sinon.stub().resolves({ _id: 'doc1', lines: [] })
      mockTools.docUpdater = {
        getDocument: sinon.stub().resolves({ lines: ['one', 'two', 'three'] }),
      }
      compactor.callsFake(async ({ readExcerpt }) => {
        const text = await readExcerpt({ path: 'main.tex', from: 2, to: 3 })
        expect(text).to.equal('two\nthree')
        return { summary: 's', ledger: {}, preTokens: 2, postTokens: 1 }
      })
      await start()
      expect(mockTools.execute.called).to.be.false
      expect(types()).to.include('compactFinished')
    })

    it('reports a refused compaction as an error with a friendly message', async function () {
      compactor.rejects(
        Object.assign(new Error('only one turn'), { code: 'compactNothing' }),
      )
      await start()
      expect(types()).to.deep.equal(['compactStarted', 'error'])
      expect(events()[1]).to.include({ code: 'compactNothing' })
      expect(events()[1].message).to.be.a('string').and.not.equal('only one turn')
      expect(mockStore.updateStatus.lastCall.args[1]).to.equal('error')
      const saved = chatHistoryStore.saveChat.getCalls().map(c => c.args[3])
      expect(saved.flat().some(entry => entry?.role === 'compact')).to.be.false
    })

    it('maps a failed compaction to compactFailed', async function () {
      compactor.rejects(
        Object.assign(new Error('provider down'), { code: 'compactFailed' }),
      )
      await start()
      expect(events()[1]).to.include({ type: 'error', code: 'compactFailed' })
      expect(events().some(event => event.type === 'compactFinished')).to.be.false
    })

    it('ends an aborted compaction as aborted', async function () {
      let begun
      const started = new Promise(resolve => (begun = resolve))
      compactor.callsFake(
        ({ signal }) =>
          new Promise((resolve, reject) => {
            begun()
            signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
          }),
      )
      const run = start()
      await started
      await manager.stopRun('run_compact')
      await run
      expect(types()).to.deep.equal(['compactStarted', 'turnFinished'])
      expect(events()[1]).to.deep.equal({ type: 'turnFinished', reason: 'aborted' })
      expect(mockStore.updateStatus.lastCall.args[1]).to.equal('stopped')
      expect(
        chatHistoryStore.saveChat.getCalls().some(c =>
          c.args[3].some(entry => entry?.role === 'compact'),
        ),
      ).to.be.false
    })

    it('reports a chat as busy only while its compaction runs', async function () {
      let begun
      let finish
      const started = new Promise(resolve => (begun = resolve))
      compactor.callsFake(async () => {
        begun()
        await new Promise(resolve => (finish = resolve))
        return { summary: 's', ledger: {}, preTokens: 2, postTokens: 1 }
      })
      const run = start()
      await started
      expect(manager.hasActiveRunForChat(PROJECT, USER, 'chat1')).to.be.true
      expect(manager.hasActiveRunForChat(PROJECT, USER, 'other')).to.be.false
      finish()
      await run
      expect(manager.hasActiveRunForChat(PROJECT, USER, 'chat1')).to.be.false
    })
  })
})
