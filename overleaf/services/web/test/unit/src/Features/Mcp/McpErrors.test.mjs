import { describe, it, expect } from 'vitest'
import McpErrors from '../../../../../app/src/Features/Mcp/McpErrors.mjs'

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
      return this
    },
    status(s) {
      this.statusCode = s
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

describe('McpErrors', () => {
  it('maps not_found to 404', () => {
    const res = fakeRes()
    McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
  })
  it('maps insufficient_scope to 403 with a default message and sets WWW-Authenticate header', () => {
    const res = fakeRes()
    McpErrors.send(res, McpErrors.CODES.INSUFFICIENT_SCOPE)
    expect(res.statusCode).toBe(403)
    expect(res.body.message).toMatch(/scope/i)
    expect(res.headers['WWW-Authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="mcp"'
    )
  })
  it('maps unauthorized to 401 and sets WWW-Authenticate header', () => {
    const res = fakeRes()
    McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
    expect(res.statusCode).toBe(401)
    expect(res.body.code).toBe('unauthorized')
    expect(res.headers['WWW-Authenticate']).toBe('Bearer')
  })
})
