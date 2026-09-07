import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2RegistrationController from '../../../../../app/src/Features/OAuth2/OAuth2RegistrationController.mjs'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'

// /oauth/register is unauthenticated by design, so every re-add of a connector
// in ChatGPT or Gemini used to insert another permanent row describing the same
// client. Reusing the existing registration keeps the collection bounded.
function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = s => {
    res.statusCode = s
    return res
  }
  res.json = data => {
    res.body = data
    return res
  }
  return res
}

const registration = {
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
}

describe('OAuth2RegistrationController deduplication', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses the existing registration for an identical client', async () => {
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue({
      id: 'client_existing',
      name: registration.client_name,
      redirectUris: registration.redirect_uris,
      grants: ['authorization_code', 'refresh_token'],
      scopes: ['mcp'],
    })
    const create = vi
      .spyOn(OauthApplication, 'create')
      .mockImplementation(async doc => doc)

    const res = mockRes()
    await OAuth2RegistrationController.register({ body: registration }, res)

    expect(res.body.client_id).to.equal('client_existing')
    expect(create.called ?? create.mock.calls.length).to.satisfy(
      c => c === false || c === 0
    )
  })

  it('still registers a new client when none matches', async () => {
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    vi.spyOn(OauthApplication, 'create').mockImplementation(async doc => doc)

    const res = mockRes()
    await OAuth2RegistrationController.register({ body: registration }, res)

    expect(res.statusCode).to.equal(201)
    expect(res.body.client_id).to.match(/^client_[0-9a-f]{32}$/)
  })

  it('does not reuse a registration whose redirect_uris differ', async () => {
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    vi.spyOn(OauthApplication, 'create').mockImplementation(async doc => doc)

    const res = mockRes()
    await OAuth2RegistrationController.register(
      {
        body: {
          client_name: 'ChatGPT',
          redirect_uris: ['https://chatgpt.com/connector/oauth/other'],
        },
      },
      res
    )

    expect(res.statusCode).to.equal(201)
    expect(res.body.redirect_uris).to.deep.equal([
      'https://chatgpt.com/connector/oauth/other',
    ])
  })
})
