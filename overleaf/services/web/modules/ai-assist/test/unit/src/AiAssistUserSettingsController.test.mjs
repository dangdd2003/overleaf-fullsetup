import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'
import { AiAssistUserSettingsController } from '../../../app/src/AiAssistUserSettingsController.mjs'

const USER_ID = '607f1f77bcf86cd799439099'

function createMockReq({ userId = USER_ID, body = {} } = {}) {
  return {
    session: {
      user: { _id: userId },
    },
    body,
  }
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.body = data
      return this
    },
  }
  return res
}

describe('AiAssistUserSettingsController', function () {
  let mockStore
  let controller

  beforeEach(function () {
    mockStore = {
      getUserSettings: vi.fn(async () => ({
        provider: { type: 'openai', model: 'gpt-5.4', hasApiKey: true, apiKey: '••••••••' },
        fastProvider: null,
        webSearch: null,
      })),
      saveUserSettings: vi.fn(async (userId, data) => ({
        provider: { type: data.provider?.type, model: data.provider?.model, hasApiKey: true, apiKey: '••••••••' },
        fastProvider: null,
        webSearch: null,
      })),
    }
    controller = new AiAssistUserSettingsController({ store: mockStore })
  })

  it('get returns masked settings for authenticated user', async function () {
    const req = createMockReq()
    const res = createMockRes()

    await controller.get(req, res)

    expect(res.statusCode).to.equal(200)
    expect(res.body.provider.apiKey).to.equal('••••••••')
    expect(mockStore.getUserSettings).toHaveBeenCalledWith(USER_ID)
  })

  it('save updates user settings and returns masked settings', async function () {
    const req = createMockReq({
      body: {
        provider: { type: 'anthropic', model: 'claude-3-7-sonnet', apiKey: 'sk-ant-test' },
      },
    })
    const res = createMockRes()

    await controller.save(req, res)

    expect(res.statusCode).to.equal(200)
    expect(res.body.provider.model).to.equal('claude-3-7-sonnet')
    expect(mockStore.saveUserSettings).toHaveBeenCalledWith(USER_ID, {
      provider: { type: 'anthropic', model: 'claude-3-7-sonnet', apiKey: 'sk-ant-test' },
      fastProvider: undefined,
      webSearch: undefined,
    })
  })
})
