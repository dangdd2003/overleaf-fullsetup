import { expect } from 'chai'
import { buildApp } from '../../../app.js'

describe('buildApp', function () {
  it('returns an object with a start method', function () {
    const app = buildApp({ enabled: false, transport: 'http' })
    expect(app).to.be.an('object')
    expect(app.start).to.be.a('function')
  })

  it('refuses to start when the feature is disabled', async function () {
    const app = buildApp({ enabled: false, transport: 'http' })
    try {
      await app.start()
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.message).to.match(/MCP_ENABLED/)
    }
  })

  it('refuses an unknown transport', async function () {
    const app = buildApp({
      enabled: true,
      transport: 'carrier-pigeon',
      internalUrl: 'http://web:3000',
    })
    try {
      await app.start()
      expect.fail('expected a throw')
    } catch (err) {
      expect(err.message).to.match(/transport/)
    }
  })
})
