import { describe, it } from 'vitest'
import { expect } from 'chai'
import sinon from 'sinon'
import { directRoute } from '../../../../app/src/web-fetch/routes/direct.mjs'
import {
  archiveTodayRoute,
  waybackRoute,
} from '../../../../app/src/web-fetch/routes/archives.mjs'
import { webError } from '../../../../app/src/web-fetch/util.mjs'
import { articlePage, htmlResponse } from './helpers/pages.mjs'

const URL_A = 'https://example.com/a'

describe('direct route', function () {
  it('asks the way a browser asks, and labels the result', async function () {
    const fetchPage = sinon
      .stub()
      .callsFake(async url => htmlResponse(url, articlePage()))
    const doc = await directRoute(URL_A, { fetchPage })
    expect(fetchPage.firstCall.args[0]).to.equal(URL_A)
    expect(fetchPage.firstCall.args[1].headers['User-Agent']).to.match(/Chrome/)
    expect(doc.quality).to.equal('ok')
    expect(doc.title).to.equal('siunitx guide')
  })
})

describe('Wayback route', function () {
  it('reads the closest capture without the archive toolbar', async function () {
    const fetchPage = sinon.stub().callsFake(async url => {
      if (url.startsWith('https://archive.org/wayback/available')) {
        return {
          url,
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              archived_snapshots: {
                closest: {
                  available: true,
                  status: '200',
                  timestamp: '20260407153000',
                },
              },
            })
          ),
        }
      }
      expect(url).to.equal(
        `https://web.archive.org/web/20260407153000id_/${URL_A}`
      )
      return htmlResponse(url, articlePage())
    })
    const doc = await waybackRoute(URL_A, { fetchPage })
    expect(doc.url).to.equal(URL_A)
    expect(doc.archived).to.equal('2026-04-07')
    expect(doc.archiveUrl).to.equal(
      `https://web.archive.org/web/20260407153000/${URL_A}`
    )
  })

  it('says so when there is no capture', async function () {
    const fetchPage = sinon.stub().resolves({
      url: 'x',
      contentType: 'application/json',
      body: Buffer.from('{"archived_snapshots":{}}'),
    })
    let error
    try {
      await waybackRoute(URL_A, { fetchPage })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('network')
    expect(error?.message).to.match(/has no archived copy/)
  })
})

describe('archive.today route', function () {
  it('follows /newest to the latest snapshot and dates it', async function () {
    const snapshot = `https://archive.ph/20260501120000/${URL_A}`
    const fetchPage = sinon.stub().callsFake(async url => {
      expect(url).to.equal(`https://archive.ph/newest/${URL_A}`)
      return htmlResponse(
        snapshot,
        articlePage().replace(
          '<body>',
          '<body><time datetime="2026-05-01T12:00:00Z">1 May</time><time datetime="2035-12-31T14:59:59Z"></time>'
        )
      )
    })
    const doc = await archiveTodayRoute(URL_A, { fetchPage })
    expect(doc.url).to.equal(URL_A)
    expect(doc.archiveUrl).to.equal(snapshot)
    expect(doc.archived).to.equal('2026-05-01')
  })

  it('reports no copy when archive.today answers 404', async function () {
    const fetchPage = sinon
      .stub()
      .rejects(webError('x returned HTTP 404.', { status: 404, kind: 'http' }))
    let error
    try {
      await archiveTodayRoute(URL_A, { fetchPage })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('network')
    expect(error?.message).to.match(/has no archive\.today copy/)
  })

  it('does not take an unrelated page for a snapshot', async function () {
    const fetchPage = sinon
      .stub()
      .callsFake(async () =>
        htmlResponse('https://archive.ph/submit/', articlePage())
      )
    let error
    try {
      await archiveTodayRoute(URL_A, { fetchPage })
    } catch (err) {
      error = err
    }
    expect(error?.message).to.match(/has no archive\.today copy/)
  })
})
