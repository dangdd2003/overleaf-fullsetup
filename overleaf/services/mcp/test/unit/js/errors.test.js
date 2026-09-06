import { expect } from 'chai'
import {
  OverleafApiError,
  codeForStatus,
  sanitiseMessage,
  toToolError,
} from '../../../src/errors.js'

describe('errors', function () {
  describe('codeForStatus', function () {
    it('maps every documented status', function () {
      expect(codeForStatus(400)).to.equal('validation_error')
      expect(codeForStatus(401)).to.equal('unauthorized')
      expect(codeForStatus(403)).to.equal('forbidden')
      expect(codeForStatus(404)).to.equal('not_found')
      expect(codeForStatus(429)).to.equal('rate_limited')
    })

    it('maps anything else to upstream_error', function () {
      expect(codeForStatus(500)).to.equal('upstream_error')
      expect(codeForStatus(502)).to.equal('upstream_error')
      expect(codeForStatus(418)).to.equal('upstream_error')
    })
  })

  describe('sanitiseMessage', function () {
    it('redacts the internal URL', function () {
      const message = sanitiseMessage(
        'failed to reach http://web:3000/api/v0/mcp/projects',
        'http://web:3000'
      )
      expect(message).to.not.include('web:3000')
      expect(message).to.include('[overleaf]')
    })

    it('redacts anything that looks like a token', function () {
      const message = sanitiseMessage('bad token olp_0123456789abcdef', 'http://web:3000')
      expect(message).to.not.include('olp_0123456789abcdef')
      expect(message).to.include('[redacted]')
    })

    it('collapses a multi-line stack trace to its first line', function () {
      const message = sanitiseMessage(
        'boom\n    at Object.<anonymous> (/overleaf/services/mcp/app.js:1:1)',
        'http://web:3000'
      )
      expect(message).to.equal('boom')
    })

    it('leaves a clean message untouched', function () {
      expect(sanitiseMessage('not found', 'http://web:3000')).to.equal('not found')
    })
  })

  describe('toToolError', function () {
    it('preserves the upstream code in the payload', function () {
      const result = toToolError(new OverleafApiError('forbidden', 'read-only', 403))
      expect(result.isError).to.be.true
      expect(JSON.parse(result.content[0].text)).to.deep.equal({
        code: 'forbidden',
        message: 'read-only',
      })
    })

    it('maps an unknown error to upstream_error without leaking its message', function () {
      const result = toToolError(new TypeError('fetch failed for http://web:3000'))
      const payload = JSON.parse(result.content[0].text)
      expect(payload.code).to.equal('upstream_error')
      expect(payload.message).to.not.include('web:3000')
    })
  })
})
