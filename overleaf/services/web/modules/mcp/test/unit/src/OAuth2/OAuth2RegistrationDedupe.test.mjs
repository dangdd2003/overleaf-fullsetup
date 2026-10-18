import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2RegistrationController from '../../../../app/src/OAuth2/OAuth2RegistrationController.mjs'
import { OauthApplication } from '../../../../../../app/src/models/OauthApplication.mjs'

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

  it('matches only on the full metadata: name, redirect URI set, grant set and public auth', async () => {
    const findOne = vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    const create = vi
      .spyOn(OauthApplication, 'create')
      .mockImplementation(async doc => doc)

    const uri = registration.redirect_uris[0]
    const other = 'https://chatgpt.com/connector/oauth/other'
    const res = mockRes()
    await OAuth2RegistrationController.register(
      {
        body: {
          client_name: 'ChatGPT',
          redirect_uris: [uri, other, uri],
          grant_types: ['refresh_token', 'authorization_code'],
        },
      },
      res
    )

    expect(findOne.mock.calls[0][0]).to.deep.equal({
      name: 'ChatGPT',
      redirectUris: { $all: [uri, other], $size: 2 },
      grants: {
        $all: ['refresh_token', 'authorization_code'],
        $size: 2,
      },
      clientSecret: null,
    })
    // The stored row holds the deduplicated set, so it can match the filter.
    expect(create.mock.calls[0][0].redirectUris).to.deep.equal([uri, other])
    expect(res.statusCode).to.equal(201)
  })

  it('creates a new client rather than reuse one with a different grant set', async () => {
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    const create = vi
      .spyOn(OauthApplication, 'create')
      .mockImplementation(async doc => doc)

    const res = mockRes()
    await OAuth2RegistrationController.register(
      {
        body: { ...registration, grant_types: ['authorization_code'] },
      },
      res
    )

    expect(create.mock.calls).to.have.lengthOf(1)
    expect(create.mock.calls[0][0].grants).to.deep.equal(['authorization_code'])
    expect(res.body.client_id).to.match(/^client_[0-9a-f]{32}$/)
  })
})
