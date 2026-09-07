import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2RegistrationController from '../../../../../app/src/Features/OAuth2/OAuth2RegistrationController.mjs'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'

describe('OAuth2RegistrationController', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects registration when client_name is missing or invalid', async () => {
    let status = null
    let responseData = null
    const req = {
      body: {
        redirect_uris: ['http://localhost:8080/callback'],
      },
    }
    const res = {
      status: s => {
        status = s
        return res
      },
      json: data => {
        responseData = data
        return res
      },
    }

    await OAuth2RegistrationController.register(req, res)
    expect(status).to.equal(400)
    expect(responseData).to.deep.equal({
      error: 'invalid_client_metadata',
      error_description: 'client_name is required',
    })
  })

  it('rejects registration when redirect_uris is missing or not an array or empty', async () => {
    let status = null
    let responseData = null
    const req = {
      body: {
        client_name: 'My Custom App',
        redirect_uris: [],
      },
    }
    const res = {
      status: s => {
        status = s
        return res
      },
      json: data => {
        responseData = data
        return res
      },
    }

    await OAuth2RegistrationController.register(req, res)
    expect(status).to.equal(400)
    expect(responseData).to.deep.equal({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris array is required',
    })
  })

  it('successfully registers a dynamic client (RFC 7591) and saves to OauthApplication', async () => {
    let createdDoc = null
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    vi.spyOn(OauthApplication, 'create').mockImplementation(async doc => {
      createdDoc = doc
      return doc
    })

    let status = null
    let responseData = null
    const req = {
      body: {
        client_name: 'Third Party AI Client',
        redirect_uris: ['http://127.0.0.1:8000/cb', 'http://localhost:8000/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
        scope: 'mcp',
      },
    }
    const res = {
      status: s => {
        status = s
        return res
      },
      json: data => {
        responseData = data
        return res
      },
    }

    await OAuth2RegistrationController.register(req, res)
    expect(status).to.equal(201)
    expect(responseData).to.have.property('client_id').that.is.a('string').and.match(/^client_[0-9a-f]{32}$/)
    expect(responseData.client_name).to.equal('Third Party AI Client')
    expect(responseData.redirect_uris).to.deep.equal(['http://127.0.0.1:8000/cb', 'http://localhost:8000/cb'])
    expect(responseData.grant_types).to.deep.equal(['authorization_code', 'refresh_token'])
    expect(responseData.scope).to.equal('mcp')
    expect(responseData.token_endpoint_auth_method).to.equal('none')

    expect(createdDoc).to.exist
    expect(createdDoc.id).to.equal(responseData.client_id)
    expect(createdDoc.name).to.equal('Third Party AI Client')
    expect(createdDoc.redirectUris).to.deep.equal(['http://127.0.0.1:8000/cb', 'http://localhost:8000/cb'])
    expect(createdDoc.pkceEnabled).to.be.true
  })

  it('uses default grant_types and scopes when not specified in registration request', async () => {
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)
    vi.spyOn(OauthApplication, 'create').mockImplementation(async doc => doc)

    let status = null
    let responseData = null
    const req = {
      body: {
        client_name: 'Default Client',
        redirect_uris: ['https://example.com/oauth/callback'],
      },
    }
    const res = {
      status: s => {
        status = s
        return res
      },
      json: data => {
        responseData = data
        return res
      },
    }

    await OAuth2RegistrationController.register(req, res)
    expect(status).to.equal(201)
    expect(responseData.grant_types).to.deep.equal(['authorization_code', 'refresh_token'])
    expect(responseData.scope).to.equal('mcp')
  })

  it('rejects registration when redirect_uris contains non-HTTP/non-HTTPS or invalid schemes', async () => {
    let status = null
    let responseData = null
    const req = {
      body: {
        client_name: 'Malicious Client',
        redirect_uris: ['javascript:alert(1)'],
      },
    }
    const res = {
      status: s => {
        status = s
        return res
      },
      json: data => {
        responseData = data
        return res
      },
    }

    await OAuth2RegistrationController.register(req, res)
    expect(status).to.equal(400)
    expect(responseData.error).to.equal('invalid_redirect_uri')
  })
})
