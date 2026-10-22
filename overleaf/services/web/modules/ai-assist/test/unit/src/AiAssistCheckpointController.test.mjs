import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import { AiAssistCheckpointController } from '../../../app/src/AiAssistCheckpointController.mjs'

describe('AiAssistCheckpointController', function () {
  const PROJECT = '0123456789abcdef01234567'
  const USER = 'abcdef0123456789abcdef01'
  const CHAT_ID = 'chat_123'
  const USER_MSG_ID = 'u_msg_001'

  let mockCheckpointStore
  let mockChatHistoryStore
  let mockDocUpdater
  let mockEntityHandler
  let mockEditorController
  let controller
  let origEnabled

  beforeEach(function () {
    origEnabled = Settings.aiAssist?.enabled
    Settings.aiAssist = { ...(Settings.aiAssist || {}), enabled: true }

    mockCheckpointStore = {
      getCheckpoint: sinon.stub().resolves(null),
      getRewindCheckpoint: sinon.stub().resolves(null),
      checkRewind: sinon.stub().resolves({
        canRewind: true,
        filesChanged: ['main.tex'],
        insertions: 5,
        deletions: 2,
      }),
      copyCheckpoints: sinon.stub().resolves([]),
      deleteChatCheckpoints: sinon.stub().resolves(),
    }

    mockChatHistoryStore = {
      truncateChat: sinon.stub().resolves({
        id: CHAT_ID,
        transcript: [{ id: USER_MSG_ID, role: 'user', text: 'Hello' }],
      }),
    }

    mockDocUpdater = {
      getDocument: sinon.stub().resolves({ lines: ['current line 1', 'current line 2'] }),
      setDocument: sinon.stub().resolves(),
    }

    mockEntityHandler = {
      getDocIdByPath: sinon.stub().resolves('doc_resolved_id'),
      getAllDocs: sinon.stub().resolves({}),
    }

    mockEditorController = {
      promises: {
        deleteEntity: sinon.stub().resolves(),
        deleteEntityWithPath: sinon.stub().resolves(),
        upsertDocWithPath: sinon.stub().resolves(),
      },
    }

    controller = new AiAssistCheckpointController({
      checkpointStore: mockCheckpointStore,
      chatHistoryStore: mockChatHistoryStore,
      docUpdater: mockDocUpdater,
      entityHandler: mockEntityHandler,
      editorController: mockEditorController,
    })
  })

  afterEach(function () {
    Settings.aiAssist.enabled = origEnabled
  })

  function mockReq(overrides = {}) {
    return {
      params: { Project_id: PROJECT, chatId: CHAT_ID },
      session: { user: { _id: USER } },
      body: {},
      ...overrides,
    }
  }

  function mockRes() {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        res.statusCode = code
        return res
      },
      json(data) {
        res.body = data
        return res
      },
      sendStatus(code) {
        res.statusCode = code
        return res
      },
    }
    return res
  }

  describe('check endpoint', function () {
    it('returns 403 when aiAssist is disabled', async function () {
      Settings.aiAssist.enabled = false
      const req = mockReq({ body: { userMessageId: USER_MSG_ID } })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(403)
      expect(res.body.error).to.equal('AI Assist is disabled')
    })

    it('returns 400 for invalid chat id', async function () {
      const req = mockReq({
        params: { Project_id: PROJECT, chatId: '../bad' },
        body: { userMessageId: USER_MSG_ID },
      })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.equal('Invalid chat id')
    })

    it('returns 400 when userMessageId is missing or invalid', async function () {
      const req = mockReq({ body: {} })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.equal('Invalid or missing userMessageId')
    })

    it('returns canRewind: false when no rewind checkpoint is found', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves(null)
      const req = mockReq({ body: { userMessageId: USER_MSG_ID } })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body).to.deep.equal({
        canRewind: false,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      })
      expect(mockCheckpointStore.checkRewind.called).to.be.false
    })

    it('checks rewind using provided currentFiles in request body', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: { 'main.tex': { originalContent: 'orig', docId: 'doc_1', isNew: false } },
      })
      const currentFiles = { 'main.tex': 'new content' }
      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          currentFiles,
        },
      })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(200)
      expect(mockCheckpointStore.checkRewind.calledOnce).to.be.true
      expect(mockCheckpointStore.checkRewind.firstCall.args[4]).to.deep.equal(currentFiles)
      expect(res.body.canRewind).to.be.true
    })

    it('fetches current files when not provided in request body', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'main.tex': { originalContent: 'orig', docId: 'doc_1', isNew: false },
        },
      })
      mockDocUpdater.getDocument.resolves({ lines: ['live line 1', 'live line 2'] })
      const req = mockReq({ body: { userMessageId: USER_MSG_ID } })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(200)
      expect(mockDocUpdater.getDocument.calledWith(PROJECT, 'doc_1', -1)).to.be.true
      expect(mockCheckpointStore.checkRewind.calledOnce).to.be.true
      expect(mockCheckpointStore.checkRewind.firstCall.args[4]).to.deep.equal({
        'main.tex': 'live line 1\nlive line 2',
      })
    })

    it('fetches current files for the merged set of files across later checkpoints', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'main.tex': { originalContent: 'orig', docId: 'doc_1', isNew: false },
          'later.tex': { originalContent: 'later orig', docId: 'doc_2', isNew: false },
        },
      })
      mockDocUpdater.getDocument.resolves({ lines: ['live'] })
      const req = mockReq({ body: { userMessageId: USER_MSG_ID } })
      const res = mockRes()

      await controller.check(req, res)
      expect(mockDocUpdater.getDocument.calledWith(PROJECT, 'doc_2', -1)).to.be.true
      expect(Object.keys(mockCheckpointStore.checkRewind.firstCall.args[4]).sort()).to.deep.equal([
        'later.tex',
        'main.tex',
      ])
    })

    it('forwards userMessageIds from the body to the store', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: { 'main.tex': { originalContent: 'orig', docId: 'doc_1' } },
      })
      const userMessageIds = [USER_MSG_ID, 'u_msg_002']
      const req = mockReq({
        body: { userMessageId: USER_MSG_ID, currentFiles: {}, userMessageIds },
      })
      const res = mockRes()

      await controller.check(req, res)
      expect(mockCheckpointStore.getRewindCheckpoint.firstCall.args).to.deep.equal([
        PROJECT,
        USER,
        CHAT_ID,
        USER_MSG_ID,
        { userMessageIds },
      ])
      expect(mockCheckpointStore.checkRewind.firstCall.args[5].userMessageIds).to.deep.equal(
        userMessageIds
      )
    })

    it('ignores userMessageIds that are not an array of strings', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: { 'main.tex': { originalContent: 'orig', docId: 'doc_1' } },
      })
      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          currentFiles: {},
          userMessageIds: [USER_MSG_ID, 42],
        },
      })
      const res = mockRes()

      await controller.check(req, res)
      expect(mockCheckpointStore.getRewindCheckpoint.firstCall.args[4]).to.deep.equal({
        userMessageIds: undefined,
      })
    })

    it('returns 500 when the checkpoint lookup throws', async function () {
      mockCheckpointStore.getRewindCheckpoint.rejects(new Error('disk fail'))
      const req = mockReq({ body: { userMessageId: USER_MSG_ID } })
      const res = mockRes()

      await controller.check(req, res)
      expect(res.statusCode).to.equal(500)
      expect(res.body.error).to.equal('Failed to check rewind')
    })
  })

  describe('rewind endpoint', function () {
    it('returns 403 when aiAssist is disabled', async function () {
      Settings.aiAssist.enabled = false
      const req = mockReq({ body: { userMessageId: USER_MSG_ID, restoreCode: true } })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(403)
      expect(res.body.error).to.equal('AI Assist is disabled')
    })

    it('returns 400 when userMessageId is invalid or missing', async function () {
      const req = mockReq({ body: { restoreCode: true } })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.equal('Invalid or missing userMessageId')
    })

    it('restores code by setting document content for modified files', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'main.tex': {
            originalContent: 'line 1\nline 2',
            docId: 'doc_1',
            isNew: false,
          },
        },
      })

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: true,
          restoreConversation: false,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.success).to.be.true
      expect(res.body.restoredFiles).to.deep.equal(['main.tex'])
      expect(res.body.failedFiles).to.deep.equal([])
      expect(res.body.transcript).to.be.undefined

      expect(mockDocUpdater.setDocument.calledOnce).to.be.true
      expect(mockDocUpdater.setDocument.firstCall.args).to.deep.equal([
        PROJECT,
        'doc_1',
        USER,
        ['line 1', 'line 2'],
        'ai-assist',
      ])
    })

    it('uses getRewindCheckpoint with the userMessageIds from the body', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves(null)
      const userMessageIds = [USER_MSG_ID, 'u_msg_002']
      const req = mockReq({
        body: { userMessageId: USER_MSG_ID, restoreCode: true, userMessageIds },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(mockCheckpointStore.getRewindCheckpoint.firstCall.args).to.deep.equal([
        PROJECT,
        USER,
        CHAT_ID,
        USER_MSG_ID,
        { userMessageIds },
      ])
    })

    it('restores code by deleting new files when isNew is true', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'created.tex': {
            originalContent: '',
            docId: 'doc_new',
            isNew: true,
          },
        },
      })

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: true,
          restoreConversation: false,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.success).to.be.true
      expect(res.body.restoredFiles).to.deep.equal(['created.tex'])

      expect(mockEditorController.promises.deleteEntity.calledOnce).to.be.true
      expect(mockEditorController.promises.deleteEntity.firstCall.args).to.deep.equal([
        PROJECT,
        'doc_new',
        'doc',
        'ai-assist',
        USER,
      ])
    })

    it('recreates a non-new file whose doc was deleted', async function () {
      mockEntityHandler.getDocPathByProjectIdAndDocId = sinon
        .stub()
        .rejects(new Error('NotFoundError'))
      mockEntityHandler.getDocIdByPath.resolves(null)
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          '/gone.tex': {
            originalContent: 'L1\nL2',
            docId: 'doc_gone',
            isNew: false,
          },
        },
      })

      const req = mockReq({
        body: { userMessageId: USER_MSG_ID, restoreCode: true },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.restoredFiles).to.deep.equal(['/gone.tex'])
      expect(res.body.failedFiles).to.deep.equal([])
      expect(mockEditorController.promises.upsertDocWithPath.calledOnce).to.be.true
      expect(mockEditorController.promises.upsertDocWithPath.firstCall.args).to.deep.equal([
        PROJECT,
        'gone.tex',
        ['L1', 'L2'],
        'ai-assist',
        USER,
      ])
      expect(mockDocUpdater.setDocument.called).to.be.false
    })

    it('reports a file as failed when it cannot be recreated', async function () {
      delete mockEditorController.promises.upsertDocWithPath
      mockEntityHandler.getDocIdByPath.resolves(null)
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: { 'gone.tex': { originalContent: 'L1', isNew: false } },
      })

      const req = mockReq({
        body: { userMessageId: USER_MSG_ID, restoreCode: true },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(500)
      expect(res.body.error).to.equal('Failed to rewind')
      expect(res.body.failedFiles).to.deep.equal([
        { path: 'gone.tex', error: 'document no longer exists' },
      ])
    })

    it('keeps going after a per-file failure and reports it', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'ok.tex': { originalContent: 'x', docId: 'd1', isNew: false },
          'bad.tex': { originalContent: 'y', docId: 'd2', isNew: false },
        },
      })
      mockDocUpdater.setDocument.callsFake(async (projectId, docId) => {
        if (docId === 'd2') throw new Error('boom')
      })
      const truncated = [{ id: USER_MSG_ID, role: 'user', text: 'Hi' }]
      mockChatHistoryStore.truncateChat.resolves({ transcript: truncated })

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: true,
          restoreConversation: true,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.success).to.be.true
      expect(res.body.restoredFiles).to.deep.equal(['ok.tex'])
      expect(res.body.failedFiles).to.deep.equal([{ path: 'bad.tex', error: 'boom' }])
      expect(res.body.transcript).to.deep.equal(truncated)
      expect(mockDocUpdater.setDocument.calledTwice).to.be.true
      expect(mockChatHistoryStore.truncateChat.calledOnce).to.be.true
    })

    it('responds 500 and does not truncate when every file failed', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: { 'bad.tex': { originalContent: 'y', docId: 'd2', isNew: false } },
      })
      mockDocUpdater.setDocument.rejects(new Error('boom'))

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: true,
          restoreConversation: true,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(500)
      expect(res.body).to.deep.equal({
        error: 'Failed to rewind',
        failedFiles: [{ path: 'bad.tex', error: 'boom' }],
      })
      expect(mockChatHistoryStore.truncateChat.called).to.be.false
    })

    it('truncates conversation when restoreConversation is true', async function () {
      const truncatedTranscript = [
        { id: 'u0', role: 'user', text: 'question 1' },
        { id: 'a0', role: 'assistant', text: 'answer 1' },
        { id: USER_MSG_ID, role: 'user', text: 'question 2' },
      ]
      mockChatHistoryStore.truncateChat.resolves({
        id: CHAT_ID,
        transcript: truncatedTranscript,
      })

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: false,
          restoreConversation: true,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.success).to.be.true
      expect(res.body.restoredFiles).to.deep.equal([])
      expect(res.body.transcript).to.deep.equal(truncatedTranscript)

      expect(mockChatHistoryStore.truncateChat.calledOnce).to.be.true
      expect(mockChatHistoryStore.truncateChat.firstCall.args[3]).to.equal(USER_MSG_ID)
      expect(mockChatHistoryStore.truncateChat.firstCall.args[4]).to.deep.equal({
        inclusive: true,
      })
    })

    it('passes inclusive: false when requested in rewind body', async function () {
      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: false,
          restoreConversation: true,
          inclusive: false,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(mockChatHistoryStore.truncateChat.firstCall.args[4]).to.deep.equal({
        inclusive: false,
      })
    })

    it('restores both code and conversation together', async function () {
      mockCheckpointStore.getRewindCheckpoint.resolves({
        userMessageId: USER_MSG_ID,
        files: {
          'chapter1.tex': {
            originalContent: 'Chapter 1 text',
            docId: 'c1',
            isNew: false,
          },
        },
      })
      const truncated = [{ id: USER_MSG_ID, role: 'user', text: 'Hi' }]
      mockChatHistoryStore.truncateChat.resolves({ transcript: truncated })

      const req = mockReq({
        body: {
          userMessageId: USER_MSG_ID,
          restoreCode: true,
          restoreConversation: true,
        },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body.success).to.be.true
      expect(res.body.restoredFiles).to.deep.equal(['chapter1.tex'])
      expect(res.body.transcript).to.deep.equal(truncated)
      expect(mockDocUpdater.setDocument.calledOnce).to.be.true
      expect(mockChatHistoryStore.truncateChat.calledOnce).to.be.true
    })

    it('returns 500 when rewind throws', async function () {
      mockCheckpointStore.getRewindCheckpoint.rejects(new Error('write fail'))
      const req = mockReq({
        body: { userMessageId: USER_MSG_ID, restoreCode: true },
      })
      const res = mockRes()

      await controller.rewind(req, res)
      expect(res.statusCode).to.equal(500)
      expect(res.body.error).to.equal('Failed to rewind')
    })
  })

  describe('fork endpoint', function () {
    it('returns 403 when aiAssist is disabled', async function () {
      Settings.aiAssist.enabled = false
      const req = mockReq({
        body: { targetChatId: 'fork_chat', userMessageIds: [USER_MSG_ID] },
      })
      const res = mockRes()

      await controller.fork(req, res)
      expect(res.statusCode).to.equal(403)
      expect(res.body.error).to.equal('AI Assist is disabled')
    })

    it('returns 400 for an invalid source chat id', async function () {
      const req = mockReq({
        params: { Project_id: PROJECT, chatId: '../bad' },
        body: { targetChatId: 'fork_chat', userMessageIds: [USER_MSG_ID] },
      })
      const res = mockRes()

      await controller.fork(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.equal('Invalid chat id')
    })

    it('returns 400 for an invalid or missing targetChatId', async function () {
      for (const targetChatId of ['../escape', '', undefined]) {
        const req = mockReq({
          body: { targetChatId, userMessageIds: [USER_MSG_ID] },
        })
        const res = mockRes()

        await controller.fork(req, res)
        expect(res.statusCode).to.equal(400)
        expect(res.body.error).to.equal('Invalid target chat id')
      }
      expect(mockCheckpointStore.copyCheckpoints.called).to.be.false
    })

    it('returns 400 when userMessageIds is not an array', async function () {
      const req = mockReq({
        body: { targetChatId: 'fork_chat', userMessageIds: USER_MSG_ID },
      })
      const res = mockRes()

      await controller.fork(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.equal('userMessageIds must be an array')
      expect(mockCheckpointStore.copyCheckpoints.called).to.be.false
    })

    it('copies checkpoints into the target chat and responds with the copied ids', async function () {
      mockCheckpointStore.copyCheckpoints.resolves([USER_MSG_ID])
      const req = mockReq({
        body: { targetChatId: 'fork_chat', userMessageIds: [USER_MSG_ID, 'u_gone'] },
      })
      const res = mockRes()

      await controller.fork(req, res)
      expect(res.statusCode).to.equal(200)
      expect(res.body).to.deep.equal({ copied: [USER_MSG_ID] })
      expect(mockCheckpointStore.copyCheckpoints.firstCall.args).to.deep.equal([
        PROJECT,
        USER,
        CHAT_ID,
        'fork_chat',
        [USER_MSG_ID, 'u_gone'],
      ])
    })

    it('returns 500 when copying fails', async function () {
      mockCheckpointStore.copyCheckpoints.rejects(new Error('disk fail'))
      const req = mockReq({
        body: { targetChatId: 'fork_chat', userMessageIds: [USER_MSG_ID] },
      })
      const res = mockRes()

      await controller.fork(req, res)
      expect(res.statusCode).to.equal(500)
      expect(res.body.error).to.equal('Failed to fork checkpoints')
    })
  })
})
