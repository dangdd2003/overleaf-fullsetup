import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import AiAssistChatHistoryStore from '../../../app/src/AiAssistChatHistoryStore.mjs'
import { AiAssistRunController } from '../../../app/src/AiAssistRunController.mjs'

describe('AiAssistModeEndpoints', () => {
  const projectId = '0123456789abcdef01234567'
  const userId = 'abcdef0123456789abcdef01'
  const chatId = 'test-chat-mode'
  let dir
  let origDir

  beforeEach(async () => {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-chats-mode-'))
    Settings.aiAssist = Settings.aiAssist || {}
    origDir = Settings.aiAssist.chatHistoryDir
    Settings.aiAssist.chatHistoryDir = dir
  })

  afterEach(async () => {
    Settings.aiAssist.chatHistoryDir = origDir
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('saves and retrieves chat with mode', async () => {
    const transcript = [{ role: 'user', text: 'Hello' }]
    await AiAssistChatHistoryStore.saveChat(projectId, userId, chatId, transcript, 'plan')

    const chat = await AiAssistChatHistoryStore.getChat(projectId, userId, chatId)
    expect(chat).to.not.be.null
    expect(chat.mode).to.equal('plan')
    expect(chat.title).to.equal('Hello')
  })

  it('defaults mode to manual when omitted in saveChat', async () => {
    const transcript = [{ role: 'user', text: 'Default test' }]
    await AiAssistChatHistoryStore.saveChat(projectId, userId, chatId, transcript)

    const chat = await AiAssistChatHistoryStore.getChat(projectId, userId, chatId)
    expect(chat.mode).to.equal('manual')
  })

  describe('AiAssistRunController.setMode', () => {
    it('sets mode on valid request', async () => {
      const mockManager = { setMode: sinon.stub().resolves() }
      const mockStore = {
        getRun: sinon.stub().resolves({ runId: 'run-1', projectId }),
      }
      const controller = new AiAssistRunController({ manager: mockManager, store: mockStore })

      const req = {
        params: { Project_id: projectId, runId: 'run-1' },
        body: { mode: 'plan' },
      }
      const res = {
        json: sinon.spy(),
        status: sinon.stub().returnsThis(),
      }

      await controller.setMode(req, res)

      expect(mockManager.setMode.calledWith('run-1', 'plan')).to.be.true
      expect(res.json.calledWith({ ok: true })).to.be.true
    })

    it('returns 400 for invalid mode', async () => {
      const mockManager = { setMode: sinon.stub().resolves() }
      const mockStore = {
        getRun: sinon.stub().resolves({ runId: 'run-1', projectId }),
      }
      const controller = new AiAssistRunController({ manager: mockManager, store: mockStore })

      const req = {
        params: { Project_id: projectId, runId: 'run-1' },
        body: { mode: 'super_invalid_mode' },
      }
      const res = {
        json: sinon.spy(),
        status: sinon.stub().returnsThis(),
      }

      await controller.setMode(req, res)

      expect(res.status.calledWith(400)).to.be.true
      expect(mockManager.setMode.called).to.be.false
    })

    it('returns 404 if run not found', async () => {
      const mockManager = { setMode: sinon.stub().resolves() }
      const mockStore = { getRun: sinon.stub().resolves(null) }
      const controller = new AiAssistRunController({ manager: mockManager, store: mockStore })

      const req = {
        params: { Project_id: projectId, runId: 'nonexistent' },
        body: { mode: 'plan' },
      }
      const res = {
        json: sinon.spy(),
        status: sinon.stub().returnsThis(),
      }

      await controller.setMode(req, res)
      expect(res.status.calledWith(404)).to.be.true
    })
  })
})
