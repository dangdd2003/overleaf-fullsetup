import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// server-ce runs `web` twice: one process with ENABLED_SERVICES=web (which is
// the only one that mounts `publicApiRouter`, where /api/v0/mcp/* lives) and
// one with ENABLED_SERVICES=api. Pointing the MCP service at the api-only
// process makes every tool call 404, so the wiring is asserted here.
const serverCe = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../server-ce'
)

function read(relative) {
  return fs.readFileSync(path.join(serverCe, relative), 'utf8')
}

describe('server-ce MCP wiring', function () {
  const webRun = read('runit/web-overleaf/run')
  const webApiRun = read('runit/web-api-overleaf/run')
  const mcpRun = read('runit/mcp-overleaf/run')
  const vhost = read('nginx/overleaf.conf')

  it('serves the web process (not the api process) on the nginx root upstream', function () {
    const webPort = /export WEB_PORT="(\d+)"/.exec(webRun)?.[1]
    expect(webPort, 'WEB_PORT in runit/web-overleaf/run').to.be.a('string')
    expect(webRun).to.match(/export ENABLED_SERVICES="web"/)
    expect(webApiRun).to.match(/export ENABLED_SERVICES="api"/)
    expect(webApiRun).to.not.match(/export WEB_PORT=/)
    expect(vhost).to.include(`proxy_pass http://127.0.0.1:${webPort};`)
  })

  it('defaults OVERLEAF_INTERNAL_URL to the web process that mounts publicApiRouter', function () {
    const webPort = /export WEB_PORT="(\d+)"/.exec(webRun)[1]
    const internalUrl = /OVERLEAF_INTERNAL_URL:-([^}"]+)/.exec(mcpRun)?.[1]
    expect(internalUrl, 'OVERLEAF_INTERNAL_URL default in runit/mcp-overleaf/run')
      .to.be.a('string')
    expect(new URL(internalUrl).port).to.equal(webPort)
  })
})
