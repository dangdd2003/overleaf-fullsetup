import { describe, it } from 'vitest'
import { expect } from 'chai'
import OAuth2RedirectUri from '../../../../../app/src/Features/OAuth2/OAuth2RedirectUri.mjs'

// Every client now arrives through dynamic client registration, so a redirect
// URI is legitimate only if that same client registered it. There is no shared
// allow-list and no wildcard matching: the sole exception is the loopback port,
// which RFC 8252 native clients cannot know ahead of registration.
const client = {
  id: 'client_abc',
  redirectUris: [
    'https://chatgpt.com/connector/oauth/callback',
    'http://127.0.0.1:1234/callback',
  ],
}

describe('OAuth2RedirectUri.isRedirectUriAllowed', () => {
  it('allows a redirect uri the client registered', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'https://chatgpt.com/connector/oauth/callback'
      )
    ).to.be.true
  })

  it('rejects a redirect uri the client did not register', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'https://chatgpt.com/connector/oauth/other'
      )
    ).to.be.false
  })

  it('rejects a host the client did not register', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'https://evil.example.com/connector/oauth/callback'
      )
    ).to.be.false
  })

  it('allows a loopback redirect on a different port (RFC 8252)', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'http://127.0.0.1:59123/callback'
      )
    ).to.be.true
  })

  it('rejects a loopback redirect with a different path', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'http://127.0.0.1:59123/stolen'
      )
    ).to.be.false
  })

  it('does not treat localhost and 127.0.0.1 as interchangeable hosts', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'http://localhost:1234/callback'
      )
    ).to.be.false
  })

  it('rejects a uri carrying userinfo', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        client,
        'https://user:pass@chatgpt.com/connector/oauth/callback'
      )
    ).to.be.false
  })

  it('rejects malformed and missing input', () => {
    expect(OAuth2RedirectUri.isRedirectUriAllowed(client, 'not-a-url')).to.be
      .false
    expect(OAuth2RedirectUri.isRedirectUriAllowed(client, '')).to.be.false
    expect(OAuth2RedirectUri.isRedirectUriAllowed(client, null)).to.be.false
    expect(OAuth2RedirectUri.isRedirectUriAllowed(client, 123)).to.be.false
    expect(OAuth2RedirectUri.isRedirectUriAllowed(null, 'https://a.test/cb')).to
      .be.false
  })

  it('rejects everything for a client with no registered uris', () => {
    expect(
      OAuth2RedirectUri.isRedirectUriAllowed(
        { id: 'c', redirectUris: [] },
        'https://chatgpt.com/connector/oauth/callback'
      )
    ).to.be.false
  })
})
