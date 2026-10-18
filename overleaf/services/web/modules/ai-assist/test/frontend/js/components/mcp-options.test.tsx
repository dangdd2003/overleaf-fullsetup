import { expect } from 'chai'
import { render, screen, fireEvent } from '@testing-library/react'
import McpOptions, {
  isSensitiveHeaderKey,
  draftFromMcp,
  mcpOptionsFromDraft,
  DraftMcpConfig,
} from '../../../../frontend/js/features/ai-assist/components/mcp-options'

describe('McpOptions', function () {
  describe('isSensitiveHeaderKey', function () {
    it('detects authorization and api key headers as sensitive', function () {
      expect(isSensitiveHeaderKey('Authorization')).to.be.true
      expect(isSensitiveHeaderKey('authorization')).to.be.true
      expect(isSensitiveHeaderKey('Proxy-Authorization')).to.be.true
      expect(isSensitiveHeaderKey('x-api-key')).to.be.true
      expect(isSensitiveHeaderKey('X-Api-Key')).to.be.true
      expect(isSensitiveHeaderKey('api-key')).to.be.true
      expect(isSensitiveHeaderKey('apiKey')).to.be.true
      expect(isSensitiveHeaderKey('auth-token')).to.be.true
      expect(isSensitiveHeaderKey('secret')).to.be.true
      expect(isSensitiveHeaderKey('token')).to.be.true
      expect(isSensitiveHeaderKey('bearer')).to.be.true
    })

    it('identifies standard headers as non-sensitive', function () {
      expect(isSensitiveHeaderKey('Content-Type')).to.be.false
      expect(isSensitiveHeaderKey('Accept')).to.be.false
      expect(isSensitiveHeaderKey('User-Agent')).to.be.false
      expect(isSensitiveHeaderKey('X-Custom-Env')).to.be.false
      expect(isSensitiveHeaderKey('')).to.be.false
    })
  })

  describe('draftFromMcp and mcpOptionsFromDraft', function () {
    it('round-trips serverUrls and custom headers', function () {
      const config = {
        enabled: true,
        serverUrls: ['https://mcp.lan/search'],
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      }

      const draft = draftFromMcp(config)
      expect(draft.serverUrls).to.deep.equal(['https://mcp.lan/search'])
      expect(draft.headers).to.deep.equal([
        { key: 'Content-Type', value: 'application/json' },
      ])

      const options = mcpOptionsFromDraft(draft)
      expect(options.serverUrls).to.deep.equal(['https://mcp.lan/search'])
      expect(options.headers).to.deep.equal([
        { key: 'Content-Type', value: 'application/json' },
      ])
    })
  })

  describe('legacy bearerToken', function () {
    it('becomes an Authorization header so saving keeps it', function () {
      const draft = draftFromMcp({
        enabled: true,
        serverUrls: ['https://search.lan/v1/search'],
        bearerToken: 'legacy-token',
      })
      expect(draft.headers).to.deep.equal([
        { key: 'Authorization', value: 'Bearer legacy-token' },
      ])
      expect(mcpOptionsFromDraft(draft).headers).to.deep.equal([
        { key: 'Authorization', value: 'Bearer legacy-token' },
      ])
    })

    it('does not override an Authorization header already set', function () {
      const draft = draftFromMcp({
        enabled: true,
        serverUrls: ['https://search.lan/v1/search'],
        bearerToken: 'legacy-token',
        headers: [{ key: 'authorization', value: 'Bearer header-token' }],
      })
      expect(draft.headers).to.deep.equal([
        { key: 'authorization', value: 'Bearer header-token' },
      ])
    })
  })

  describe('component UI rendering and header masking', function () {
    it('reveals non-sensitive header while hiding sensitive header', function () {
      const draft: DraftMcpConfig = {
        serverUrls: ['https://mcp.example.com'],
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer secret-header-456' },
        ],
      }

      const { container } = render(
        <McpOptions value={draft} onChange={() => {}} />
      )

      // Content-Type value is non-sensitive: rendered as type="text" (revealed, no hiding)
      const contentTypeInput = container.querySelector(
        '#ai-web-search-mcp-header-value-0'
      ) as HTMLInputElement
      expect(contentTypeInput).to.exist
      expect(contentTypeInput.type).to.equal('text')
      expect(contentTypeInput.value).to.equal('application/json')

      // Authorization value is sensitive: rendered as type="password" (hidden)
      const authHeaderInput = container.querySelector(
        '#ai-web-search-mcp-header-value-1'
      ) as HTMLInputElement
      expect(authHeaderInput).to.exist
      expect(authHeaderInput.type).to.equal('password')
      expect(authHeaderInput.value).to.equal('Bearer secret-header-456')

      // Toggling visibility reveals the sensitive header
      const toggleBtn = container.querySelector(
        '#ai-web-search-mcp-header-toggle-btn-1'
      )
      expect(toggleBtn).to.exist
      fireEvent.click(toggleBtn!)
      expect(authHeaderInput.type).to.equal('text')
    })

    it('maintains revealed state of remaining headers when an earlier header is removed', function () {
      let draft: DraftMcpConfig = {
        serverUrls: ['https://mcp.example.com'],
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer token-1' },
          { key: 'X-Api-Key', value: 'secret-key-2' },
        ],
      }

      const { container, rerender } = render(
        <McpOptions
          value={draft}
          onChange={updated => {
            draft = updated
          }}
        />
      )

      // Reveal header 1 (Authorization)
      const toggleBtn1 = container.querySelector(
        '#ai-web-search-mcp-header-toggle-btn-1'
      )
      expect(toggleBtn1).to.exist
      fireEvent.click(toggleBtn1!)

      const authInput = container.querySelector(
        '#ai-web-search-mcp-header-value-1'
      ) as HTMLInputElement
      expect(authInput.type).to.equal('text')

      // Remove header 0 (Content-Type)
      const removeBtn0 = screen.getByLabelText('Remove header 1')
      expect(removeBtn0).to.exist
      fireEvent.click(removeBtn0)

      rerender(
        <McpOptions
          value={draft}
          onChange={updated => {
            draft = updated
          }}
        />
      )

      // Header 0 is now Authorization, and it MUST still be revealed (type="text")
      const newHeader0Input = container.querySelector(
        '#ai-web-search-mcp-header-value-0'
      ) as HTMLInputElement
      expect(newHeader0Input.value).to.equal('Bearer token-1')
      expect(newHeader0Input.type).to.equal('text')

      // Header 1 is now X-Api-Key, and it MUST still be masked (type="password")
      const newHeader1Input = container.querySelector(
        '#ai-web-search-mcp-header-value-1'
      ) as HTMLInputElement
      expect(newHeader1Input.value).to.equal('secret-key-2')
      expect(newHeader1Input.type).to.equal('password')
    })
  })
})
