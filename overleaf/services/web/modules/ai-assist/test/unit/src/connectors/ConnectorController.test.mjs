import { describe, it, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import ConnectorService from '../../../../app/src/connectors/ConnectorService.mjs'
import { ConnectorController } from '../../../../app/src/connectors/ConnectorController.mjs'

const CONNECTOR_ID = '507f1f77bcf86cd799439011'
const USER_ID = '607f1f77bcf86cd799439099'

// The callback page carries its outcome as a JSON literal in its script
function payloadOf(html) {
  const match = html.match(/const payload = (.*);\n/)
  expect(match, 'payload in callback page').to.exist
  return JSON.parse(match[1].replace(/\\u003c/g, '<'))
}

async function runCallback(query) {
  const res = {
    locals: {},
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    send(html) {
      this.html = html
    },
  }
  const req = { query, user: { _id: USER_ID } }
  await ConnectorController.oauthCallback(req, res, () => {})
  return payloadOf(res.html)
}

describe('ConnectorController.oauthCallback', function () {
  const originalSiteUrl = Settings.siteUrl

  afterEach(function () {
    vi.restoreAllMocks()
    Settings.siteUrl = originalSiteUrl
  })

  it('reports connected only when the follow-up connect succeeded', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockResolvedValue({
      connector: { id: CONNECTOR_ID, lastError: null },
      next: 'connected',
    })

    const outcome = await runCallback({ code: 'c', state: 's' })

    expect(outcome).to.deep.equal({
      type: 'ai-assist:connector-oauth',
      connectorId: CONNECTOR_ID,
      status: 'connected',
    })
  })

  it('reports an error with the connector message when the connect after sign-in fails', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockResolvedValue({
      connector: {
        id: CONNECTOR_ID,
        lastError: { message: 'Server unreachable after sign-in' },
      },
      next: 'error',
    })

    const outcome = await runCallback({ code: 'c', state: 's' })

    expect(outcome.status).to.equal('error')
    expect(outcome.error).to.equal('Server unreachable after sign-in')
    expect(outcome.connectorId).to.equal(CONNECTOR_ID)
  })

  it('reports a still-asks-for-sign-in result as an error, not a success', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockResolvedValue({
      connector: { id: CONNECTOR_ID, lastError: null },
      next: 'authorize',
    })

    const outcome = await runCallback({ code: 'c', state: 's' })

    expect(outcome.status).to.equal('error')
    expect(outcome.error).to.match(/still asks for sign-in/)
  })

  it('names the connector and the reason when the user denies access', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockRejectedValue(
      new Error('The user denied access')
    )

    const outcome = await runCallback({
      error: 'access_denied',
      error_description: 'The user denied access',
      state: 's',
    })

    expect(outcome.status).to.equal('error')
    expect(outcome.error).to.equal('The user denied access')
    expect(outcome.connectorId).to.equal(CONNECTOR_ID)
  })

  it('names the connector on an issuer mismatch', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockRejectedValue(
      new Error('Issuer mismatch: expected https://a, got https://b')
    )

    const outcome = await runCallback({ code: 'c', state: 's', iss: 'https://b' })

    expect(outcome.connectorId).to.equal(CONNECTOR_ID)
    expect(outcome.error).to.match(/Issuer mismatch/)
  })

  it('leaves the connector id empty when the state is unknown', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue('')
    vi.spyOn(ConnectorService, 'handleCallback').mockRejectedValue(
      new Error('This sign-in link was already used, has expired, or belongs to another account.')
    )

    const outcome = await runCallback({ code: 'c', state: 'old' })

    expect(outcome.connectorId).to.equal('')
    expect(outcome.status).to.equal('error')
  })

  it('keeps the page payload safe inside a script', async function () {
    vi.spyOn(ConnectorService, 'pendingConnectorId').mockResolvedValue(CONNECTOR_ID)
    vi.spyOn(ConnectorService, 'handleCallback').mockRejectedValue(
      new Error('</script><script>alert(1)</script>')
    )
    const res = {
      locals: {},
      setHeader() {},
      send(html) {
        this.html = html
      },
    }

    await ConnectorController.oauthCallback(
      { query: { state: 's' }, user: { _id: USER_ID } },
      res,
      () => {}
    )

    expect(res.html).to.not.include('</script><script>alert(1)')
    expect(payloadOf(res.html).error).to.equal('</script><script>alert(1)</script>')
  })
})
