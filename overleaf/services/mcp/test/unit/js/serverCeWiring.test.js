import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, WEB_INTERNAL_URL } from '../../../src/config.js'

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

  it('reaches the web process that mounts publicApiRouter at its internal URL', function () {
    const webPort = /export WEB_PORT="(\d+)"/.exec(webRun)[1]
    expect(new URL(WEB_INTERNAL_URL).port).to.equal(webPort)
  })

  it('proxies /mcp to the port the MCP service listens on', function () {
    const { port } = loadConfig({ MCP_ENABLED: 'true', OVERLEAF_SITE_URL: 'http://localhost' })
    const template = read('nginx/mcp.conf.template')
    expect(template).to.include(`proxy_pass http://127.0.0.1:${port};`)
  })

  it('defaults OVERLEAF_SITE_URL to the siteUrl web signs tokens with', function () {
    const settings = read('config/settings.js')
    const webDefault = /OVERLEAF_SITE_URL \|\| '([^']+)'/.exec(settings)?.[1]
    const mcpDefault = /OVERLEAF_SITE_URL:-([^}"]+)/.exec(mcpRun)?.[1]
    expect(mcpDefault, 'OVERLEAF_SITE_URL default in runit/mcp-overleaf/run')
      .to.be.a('string')
    expect(mcpDefault).to.equal(webDefault)
  })
})
