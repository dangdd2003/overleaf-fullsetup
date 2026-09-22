import { expect } from 'chai'
import sinon from 'sinon'
import { AiAssistChatHistoryController } from '../../../app/src/AiAssistChatHistoryController.mjs'

describe('AiAssistChatHistoryController', function () {
  const PROJECT = '0123456789abcdef01234567'
  const USER = 'abcdef0123456789abcdef01'
  const CHAT_ID = 'chat123'

  let mockStore
  let mockClientFactory
  let controller

  beforeEach(function () {
    mockStore = {
      listChats: sinon.stub().resolves([]),
      getChat: sinon.stub().resolves(null),
      saveChat: sinon.stub().resolves({ id: CHAT_ID, title: 'Test Chat' }),
      saveChatTitle: sinon.stub().resolves({ id: CHAT_ID, title: 'Renamed Chat' }),
      deleteChat: sinon.stub().resolves(),
    }
    mockClientFactory = sinon.stub().returns({
      async *streamChat() {
        yield { type: 'text', text: 'Auto Title' }
      },
    })
    controller = new AiAssistChatHistoryController({
      store: mockStore,
      clientFactory: mockClientFactory,
    })
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

  it('saves chat with optional title and mode', async function () {
    const req = mockReq({
      body: {
        transcript: [{ role: 'user', text: 'Hello' }],
        mode: 'acceptEdits',
        title: 'Custom Title',
      },
    })
    const res = mockRes()

    await controller.save(req, res)
    expect(res.statusCode).to.equal(200)
    expect(mockStore.saveChat.calledOnce).to.be.true
    const args = mockStore.saveChat.firstCall.args
    expect(args[0]).to.equal(PROJECT)
    expect(args[1]).to.equal(USER)
    expect(args[2]).to.equal(CHAT_ID)
    expect(args[4]).to.equal('acceptEdits')
    expect(args[5]).to.equal('Custom Title')
  })

  it('renames chat title via rename endpoint', async function () {
    const req = mockReq({
      body: { title: 'New Name' },
    })
    const res = mockRes()

    await controller.rename(req, res)
    expect(res.statusCode).to.equal(200)
    expect(mockStore.saveChatTitle.calledOnce).to.be.true
    expect(mockStore.saveChatTitle.firstCall.args).to.deep.equal([
      PROJECT,
      USER,
      CHAT_ID,
      'New Name',
    ])
    expect(res.body).to.deep.equal({ id: CHAT_ID, title: 'Renamed Chat' })
  })

  it('rejects empty title in rename endpoint', async function () {
    const req = mockReq({
      body: { title: '   ' },
    })
    const res = mockRes()

    await controller.rename(req, res)
    expect(res.statusCode).to.equal(400)
    expect(mockStore.saveChatTitle.called).to.be.false
  })

  it('generates chat title using provider client', async function () {
    const req = mockReq({
      body: {
        providerSettings: { type: 'openai' },
        prompt: 'Fix the references in references.bib',
      },
    })
    const res = mockRes()

    await controller.generateTitle(req, res)
    expect(res.statusCode).to.equal(200)
    expect(res.body.title).to.equal('Auto Title')
    expect(mockStore.saveChatTitle.calledOnce).to.be.true
    expect(mockStore.saveChatTitle.firstCall.args[3]).to.equal('Auto Title')
  })
})
