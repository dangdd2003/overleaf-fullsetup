import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  THIN_CHARS,
  assessContent,
  isChallenge,
} from '../../../../app/src/web-fetch/quality.mjs'
import { documentFromResponse } from '../../../../app/src/web-fetch/document.mjs'
import {
  AKAMAI_DENIED,
  ARTICLE_TEXT,
  CLOUDFLARE_CHALLENGE,
  DATADOME_BLOCK,
  articlePage,
  htmlResponse,
  spaShell,
} from './helpers/pages.mjs'

describe('quality check', function () {
  it('recognises the common bot checks', function () {
    for (const [name, html] of [
      ['cloudflare', CLOUDFLARE_CHALLENGE],
      ['akamai', AKAMAI_DENIED],
      ['datadome', DATADOME_BLOCK],
      ['perimeterx', '<div id="px-captcha"></div>'],
      ['incapsula', '<script src="/_Incapsula_Resource?SWJIYLWA=1"></script>'],
      [
        'archive.today',
        '<p>Please complete the security check to access archive.ph</p>',
      ],
    ]) {
      expect(assessContent({ html, text: 'short' }), name).to.equal('challenge')
    }
  })

  it('also reads a bot check out of text a reader API returned', function () {
    expect(
      assessContent({
        text: 'Just a moment... Enable JavaScript and cookies to continue',
      })
    ).to.equal('challenge')
  })

  it('never calls a page with plenty of text a bot check', function () {
    const text = `${ARTICLE_TEXT.repeat(3)} Cloudflare shows "Checking your browser" pages to bots.`
    expect(text.length).to.be.greaterThan(2000)
    expect(isChallenge('<p>Checking your browser</p>', text)).to.equal(false)
  })

  it('calls an empty JavaScript shell thin', function () {
    expect(assessContent({ html: spaShell(), text: 'App' })).to.equal('thin')
    expect(
      assessContent({ html: '<body><div id="__next"></div></body>', text: '' })
    ).to.equal('thin')
    expect(
      assessContent({
        html: '<html ng-app="x"><body></body></html>',
        text: 'x',
      })
    ).to.equal('thin')
  })

  it('accepts a short page that is not a shell, and short plain text', function () {
    expect(
      assessContent({
        html: '<html><body>content</body></html>',
        text: 'content',
      })
    ).to.equal('ok')
    expect(assessContent({ text: '\\ProvidesPackage{a}' })).to.equal('ok')
    expect(THIN_CHARS).to.equal(400)
  })

  it('labels every HTML document it reads', async function () {
    const ok = await documentFromResponse(
      htmlResponse('https://a.org/', articlePage())
    )
    expect(ok.quality).to.equal('ok')
    const blocked = await documentFromResponse(
      htmlResponse('https://a.org/', CLOUDFLARE_CHALLENGE)
    )
    expect(blocked.quality).to.equal('challenge')
  })

  it('marks a page with no text at all as thin, so another route is tried', async function () {
    let error
    try {
      await documentFromResponse(
        htmlResponse('https://a.org/', '<html><body></body></html>')
      )
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('thin')
    expect(error?.message).to.match(/no readable text/)
  })
})
