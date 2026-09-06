import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2PreconfiguredClients from '../../../../../app/src/Features/OAuth2/OAuth2PreconfiguredClients.mjs'
import OAuth2RegistrationController from '../../../../../app/src/Features/OAuth2/OAuth2RegistrationController.mjs'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'

describe('OAuth2PreconfiguredClients', () => {
  it('resolves Claude Desktop client and allows loopback ports and cloud callbacks', () => {
    const client = OAuth2PreconfiguredClients.getClient('claude')
    expect(client).to.exist
    expect(client.name).to.include('Claude')

    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://localhost:54321/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://127.0.0.1:9999/auth'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://claude.ai/api/mcp/oauth_callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://evil.com/callback'
      )
    ).to.be.false
  })

  it('resolves claude-desktop client with loopback redirect URIs', () => {
    const client = OAuth2PreconfiguredClients.getClient('claude-desktop')
    expect(client).to.exist
    expect(client.name).to.include('Claude Desktop')

    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://localhost:12345/oauth/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://127.0.0.1:54321/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://claude.ai/callback'
      )
    ).to.be.false
  })

  it('resolves ChatGPT client and allows ChatGPT callback URLs', () => {
    const chatgpt = OAuth2PreconfiguredClients.getClient('chatgpt')
    expect(chatgpt).to.exist
    expect(chatgpt.name).to.include('ChatGPT')
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        chatgpt,
        'https://chatgpt.com/connector/oauth/callback/123'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        chatgpt,
        'https://chatgpt.com/connector/oauth/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        chatgpt,
        'https://other.com/oauth'
      )
    ).to.be.false
  })

  it('resolves Gemini and Goose preconfigured clients with loopback support', () => {
    const gemini = OAuth2PreconfiguredClients.getClient('gemini')
    expect(gemini).to.exist
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        gemini,
        'http://localhost:8080/oauth'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        gemini,
        'http://127.0.0.1:3000/callback'
      )
    ).to.be.true

    const goose = OAuth2PreconfiguredClients.getClient('goose')
    expect(goose).to.exist
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        goose,
        'http://localhost:3000/oauth/callback'
      )
    ).to.be.true
  })

  it('allows standard integration callbacks matching Google Drive and GitHub sync patterns', () => {
    process.env.OVERLEAF_URL = 'https://custom-domain.example.com'
    const client = OAuth2PreconfiguredClients.getClient('claude')

    // Matches GitHub (${siteUrl}/user/github/callback) and Google Drive (${siteUrl}/user/google-drive/callback)
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://custom-domain.example.com/user/mcp/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://custom-domain.example.com/oauth/callback'
      )
    ).to.be.true
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://unauthorized-domain.com/user/mcp/callback'
      )
    ).to.be.false
    delete process.env.OVERLEAF_URL
  })

  it('strictly rejects loopback redirect URIs with userinfo tricks', () => {
    const client = OAuth2PreconfiguredClients.getClient('claude')
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://localhost:@evil.com/callback'
      )
    ).to.be.false
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://localhost:8080@evil.com/callback'
      )
    ).to.be.false
    expect(
      OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'http://127.0.0.1:@evil.com/callback'
      )
    ).to.be.false
  })

  it('returns null for unknown client id', () => {
    expect(OAuth2PreconfiguredClients.getClient('unknown-client')).to.be.null
    expect(OAuth2PreconfiguredClients.getClient(null)).to.be.null
  })

  it('returns false for null client or empty uri in isRedirectUriAllowed', () => {
    expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(null, 'http://localhost')).to.be.false
    const client = OAuth2PreconfiguredClients.getClient('claude')
    expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, null)).to.be.false
    expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, '')).to.be.false
  })
})

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
