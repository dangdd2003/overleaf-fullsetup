import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import * as Fetch from '../../../app/src/services/mirror/Fetch.mjs'
import * as MirrorService from '../../../app/src/services/mirror/MirrorService.mjs'
import * as GalleryReadService from '../../../app/src/services/GalleryReadService.mjs'
import { resetBlockedPdfBackoff } from '../../../app/src/services/mirror/MirrorService.mjs'
import { createFakeCollection, rejectionOf } from './S-P4-support.mjs'
import { OUTBOUND_BLOCKED } from '../../../app/src/transport/GuardedHttps.mjs'

const TOKEN = 'abcdefghijkl'
const FUTURE = () => new Date(Date.now() + 60 * 60_000)
const PAST = () => new Date(Date.now() - 1000)
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(200, 1),
])

const DETAIL_HTML = `
  <div class="gallery-item-title"><h1>Sample</h1></div>
  <div class="cta-links">
    <a class="cta-link" href="/project/new/template/999?id=12345&amp;mainFile=main.tex">Open</a>
  </div>
  <div class="gallery-large-pdf-preview">
    <img src="https://writelatex.s3.amazonaws.com/published_ver/12345.jpeg?X-Amz-Signature=abc">
  </div>
  <div class="gallery-abstract"><p>Abstract</p></div>
`

const TAG_HTML = `
  <h1 class="gallery-title">LaTeX templates — Curricula Vitae</h1>
  <div class="gallery-filters"><a class="active" href="/latex/templates/tagged/cv">Active</a></div>
  <p class="gallery-summary">A curated list.</p>
`

function hostBusy() {
  const err = new Error('templates already has 200 requests queued')
  err.code = 'host_busy'
  return err
}

function httpFailure(status) {
  const err = new Error(`HTTP ${status}`)
  err.status = status
  err.code = `EHTTP_${status}`
  return err
}

function pageResult(html, url) {
  return {
    status: 200,
    statusCode: 200,
    body: Buffer.from(html),
    truncated: false,
    headers: {},
    contentType: 'text/html',
    url,
  }
}

function tokenOf(prefix, index) {
  return prefix.repeat(8) + String.fromCharCode(97 + index) + 'xyz'
}

function cardHtml(token, { image = null } = {}) {
  const thumb = image
    ? `<div class="thumbnail"><img src="${image}" alt="card"></div>`
    : ''
  return `<div class="gallery-thumbnail">
    <a href="/latex/templates/card-${token}/${token}">${thumb}
      <div class="caption"><div class="caption-title">Card ${token}</div></div>
    </a>
  </div>`
}

function listingHtml(cards, page, lastPage = 5) {
  return `<div class="gallery-grid">${cards.join('\n')}</div>
    <ul class="pagination">
      <li class="active"><a href="#">${page}</a></li>
      <li><a href="/gallery/recent/page/${lastPage}" aria-label="Go to last page">Last</a></li>
    </ul>`
}

function pageNumber(href) {
  const match = /\/recent\/page\/(\d+)/.exec(href)
  return match ? Number(match[1]) : 1
}

describe('S-P4 MirrorService: public views and crawl runs respect backoff', () => {
  const originalStorageDir = DEFAULTS.storageDir
  let tmpDir
  let items
  let tags
  let listings

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-p4-mirror-'))
    DEFAULTS.storageDir = tmpDir
    Settings.templateGallery = { ...DEFAULTS, storageDir: tmpDir }
    items = createFakeCollection()
    tags = createFakeCollection()
    listings = createFakeCollection()
    setCollectionOverrideForTests({
      templateGalleryItems: items,
      templateGalleryTags: tags,
      templateGalleryListings: listings,
    })
  })

  afterEach(async () => {
    DEFAULTS.storageDir = originalStorageDir
    setCollectionOverrideForTests(null)
    Fetch.setFetchOverridesForTests(null)
    vi.restoreAllMocks()
    await fs.promises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {})
  })

  async function seedItem(extra = {}) {
    await items.updateOne(
      { token: TOKEN },
      {
        $set: {
          token: TOKEN,
          family: 'template',
          slug: 'sample',
          source: 'crawler',
          state: 'published',
          objectID: '555',
          objectIDNum: 555,
          title: 'Sample',
          ...extra,
        },
      },
      { upsert: true }
    )
  }

  // Transport stub for every upstream call: overleaf.com pages and S3 images.
  function upstream({
    image = 'fail',
    imageStatus = 503,
    busy = false,
    tagStatus = 200,
  } = {}) {
    const calls = { page: 0, image: 0, tag: 0 }
    Fetch.setFetchOverridesForTests({
      withHostSlot: busy
        ? async () => {
            throw hostBusy()
          }
        : (key, opts, fn) => fn(),
      requestRaw: async url => {
        const href = String(url)
        if (href.includes('writelatex.s3.amazonaws.com')) {
          calls.image++
          if (image === 'ok') {
            return {
              status: 200,
              statusCode: 200,
              body: JPEG,
              truncated: false,
              headers: {},
              url: href,
            }
          }
          throw httpFailure(imageStatus)
        }
        if (href.includes('/tagged/')) {
          calls.tag++
          if (tagStatus !== 200) throw httpFailure(tagStatus)
          return pageResult(TAG_HTML, href)
        }
        calls.page++
        return pageResult(DETAIL_HTML, href)
      },
      fetchStream: async () => {
        throw new Error('fetchStream is not used by these tests')
      },
    })
    return calls
  }

  describe('image download backoff', () => {
    it('a failed preview download backs off: repeat public views do not re-fetch the page or the image', async () => {
      await seedItem()
      const calls = upstream({ imageStatus: 503 })

      expect(
        await MirrorService.ensureMedia(TOKEN, 'thumb', {
          priority: 'interactive',
        })
      ).toBeNull()
      expect(calls.image).toBe(1)

      const doc = await items.findOne({ token: TOKEN })
      expect(doc.mirror.imageAttempts).toBe(1)
      expect(doc.mirror.imageLastError).toContain('HTTP 503')
      expect(new Date(doc.mirror.imageNextAttemptAt).getTime()).toBeGreaterThan(
        Date.now()
      )

      const pageCallsBefore = calls.page
      for (let i = 0; i < 3; i++) {
        expect(
          await MirrorService.ensureMedia(TOKEN, 'preview', {
            priority: 'interactive',
          })
        ).toBeNull()
      }
      expect(calls.page).toBe(pageCallsBefore)
      expect(calls.image).toBe(1)
    })

    it('after the delay expires a later view retries, and force bypasses the backoff', async () => {
      await seedItem()
      const calls = upstream({ imageStatus: 503 })
      await MirrorService.ensureMedia(TOKEN, 'thumb')
      expect(calls.image).toBe(1)

      await items.updateOne(
        { token: TOKEN },
        { $set: { 'mirror.imageNextAttemptAt': PAST() } }
      )
      await MirrorService.ensureMedia(TOKEN, 'thumb')
      expect(calls.image).toBe(2)

      await MirrorService.ensureMedia(TOKEN, 'thumb', { force: true })
      expect(calls.image).toBe(3)
      const doc = await items.findOne({ token: TOKEN })
      expect(doc.mirror.imageAttempts).toBe(3)
    })

    it('a backed-off image is not re-downloaded while the detail page refreshes', async () => {
      await seedItem({
        mirror: { imageAttempts: 1, imageNextAttemptAt: FUTURE() },
      })
      const calls = upstream({ image: 'ok' })

      const refreshed = await MirrorService.ensureDetail(TOKEN, {
        priority: 'interactive',
        force: true,
      })
      expect(refreshed.mirror.detailAt).toBeTruthy()
      expect(calls.page).toBe(1)
      expect(calls.image).toBe(0)
    })

    it('a successful preview download stores the blob and clears the backoff', async () => {
      await seedItem({
        mirror: {
          imageAttempts: 2,
          imageLastError: 'old',
          imageNextAttemptAt: PAST(),
        },
      })
      const calls = upstream({ image: 'ok' })

      const media = await MirrorService.ensureMedia(TOKEN, 'thumb')
      expect(media?.sha).toMatch(/^[0-9a-f]{64}$/)
      expect(calls.image).toBe(1)

      const doc = await items.findOne({ token: TOKEN })
      expect(doc.mirror.imageAttempts).toBe(0)
      expect(doc.mirror.imageLastError).toBeNull()
      expect(doc.mirror.imageNextAttemptAt).toBeNull()
    })

    it('a crawl scan does not re-download an image inside its backoff window', async () => {
      const token = tokenOf('n', 0)
      const image =
        'https://writelatex.s3.amazonaws.com/published_ver/777.jpeg?X-Amz-Signature=x'
      const listing = [cardHtml(token, { image })]
      vi.spyOn(Fetch, 'fetchOverleafPage').mockImplementation(async href => ({
        status: 200,
        html: listingHtml(listing, pageNumber(href)),
        url: href,
      }))
      const calls = upstream({ imageStatus: 503 })

      await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 1,
        mode: 'incremental',
      })
      expect(calls.image).toBe(1)
      const afterFirst = await items.findOne({ token })
      expect(
        new Date(afterFirst.mirror.imageNextAttemptAt).getTime()
      ).toBeGreaterThan(Date.now())

      await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 1,
        mode: 'incremental',
      })
      expect(calls.image).toBe(1)
    })
  })

  describe('tag scrape backoff', () => {
    it('a failing tag scrape backs off for public views', async () => {
      const calls = upstream({ tagStatus: 500 })

      expect(
        await MirrorService.ensureTag('templates', 'cv', {
          priority: 'interactive',
        })
      ).toBeNull()
      expect(calls.tag).toBe(1)

      const doc = await tags.findOne({ _id: 'cv' })
      expect(doc.failures.templates.attempts).toBe(1)
      expect(doc.failures.templates.lastError).toContain('HTTP 500')
      expect(
        new Date(doc.failures.templates.nextAttemptAt).getTime()
      ).toBeGreaterThan(Date.now())

      const again = await MirrorService.ensureTag('templates', 'cv', {
        priority: 'interactive',
      })
      expect(calls.tag).toBe(1)
      expect(again?.byScope?.templates).toBeUndefined()
    })

    it('a tag retried after its delay is recorded with a longer backoff', async () => {
      const calls = upstream({ tagStatus: 500 })
      await MirrorService.ensureTag('templates', 'cv')
      await tags.updateOne(
        { _id: 'cv' },
        { $set: { 'failures.templates.nextAttemptAt': PAST() } }
      )

      await MirrorService.ensureTag('templates', 'cv')
      expect(calls.tag).toBe(2)
      const doc = await tags.findOne({ _id: 'cv' })
      expect(doc.failures.templates.attempts).toBe(2)
    })

    it('a successful tag scrape clears the recorded failure', async () => {
      await tags.updateOne(
        { _id: 'cv' },
        {
          $set: {
            failures: { templates: { attempts: 2, nextAttemptAt: PAST() } },
          },
        },
        { upsert: true }
      )
      const calls = upstream({ tagStatus: 200 })

      const doc = await MirrorService.ensureTag('templates', 'cv', {
        priority: 'interactive',
      })
      expect(calls.tag).toBe(1)
      expect(doc.byScope.templates.h1Title).toBe('Curricula Vitae')
      expect(doc.failures.templates).toBeNull()
    })

    it('the tag batch skips tags that are inside their backoff window', async () => {
      await tags.updateOne(
        { _id: 'cv' },
        {
          $set: {
            counts: { template: 3, example: 0, article: 0 },
            failures: {
              templates: { attempts: 1, nextAttemptAt: FUTURE() },
              gallery: { attempts: 1, nextAttemptAt: FUTURE() },
            },
          },
        },
        { upsert: true }
      )
      const calls = upstream()

      const result = await MirrorService.runTagBatch({ limit: 10 })
      expect(result).toEqual({ processed: 0, failed: 0 })
      expect(calls.tag).toBe(0)
    })
  })

  describe('limiter refusals', () => {
    it('host_busy is not an item failure and gives a public view no data', async () => {
      await seedItem()
      upstream({ busy: true })

      expect(
        await MirrorService.ensureDetail(TOKEN, { priority: 'interactive' })
      ).toBeNull()
      const doc = await items.findOne({ token: TOKEN })
      expect(doc.mirror?.attempts ?? 0).toBe(0)
      expect(doc.mirror?.nextAttemptAt ?? null).toBeNull()
      expect(doc.mirror?.lastError ?? null).toBeNull()
    })

    it('host_busy still surfaces to callers that asked to throw (admin hydrate)', async () => {
      await seedItem()
      upstream({ busy: true })

      expect(
        await rejectionOf(
          MirrorService.ensureDetail(TOKEN, {
            priority: 'interactive',
            throwOnError: true,
          })
        )
      ).toMatchObject({ code: 'host_busy' })
    })

    it('the public read layer reports a refusal as not available (null), never as an error', async () => {
      await seedItem({ objectID: '555' })
      upstream({ busy: true })
      const item = await items.findOne({ token: TOKEN })

      expect(await GalleryReadService.ensureMedia(item, 'thumb')).toBeNull()
      expect(await GalleryReadService.ensurePdf(item)).toBeNull()
    })

    it('host_busy on a tag does not record a tag failure', async () => {
      upstream({ busy: true })

      expect(
        await MirrorService.ensureTag('templates', 'cv', {
          priority: 'interactive',
        })
      ).toBeNull()
      expect(await tags.findOne({ _id: 'cv' })).toBeNull()
    })
  })

  describe('recent head scan', () => {
    it('stops paging once a page holds nothing new', async () => {
      const known = Array.from({ length: 9 }, (_, i) => tokenOf('k', i))
      for (const [i, token] of known.entries()) {
        await items.updateOne(
          { token },
          {
            $set: {
              token,
              family: 'template',
              slug: 's',
              source: 'crawler',
              state: 'published',
              recentOrder: 1000 + i,
            },
          },
          { upsert: true }
        )
      }
      const fresh = tokenOf('n', 0)
      const pages = {
        1: [fresh, ...known.slice(0, 8)].map(token => cardHtml(token)),
        2: known.map(token => cardHtml(token)),
        3: [tokenOf('m', 0), tokenOf('m', 1)].map(token => cardHtml(token)),
      }
      const spy = vi
        .spyOn(Fetch, 'fetchOverleafPage')
        .mockImplementation(async href => ({
          status: 200,
          html: listingHtml(pages[pageNumber(href)], pageNumber(href)),
          url: href,
        }))

      const scan = await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 3,
        mode: 'incremental',
      })
      expect(scan.pages).toBe(2)
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls.some(([href]) => pageNumber(href) === 3)).toBe(
        false
      )

      const freshDoc = await items.findOne({ token: fresh })
      expect(Number.isFinite(freshDoc.recentOrder)).toBe(true)
      expect(await items.findOne({ token: tokenOf('m', 0) })).toBeNull()
    })

    it('fetches only the first page when that page is already known', async () => {
      const known = Array.from({ length: 9 }, (_, i) => tokenOf('k', i))
      for (const [i, token] of known.entries()) {
        await items.updateOne(
          { token },
          {
            $set: {
              token,
              family: 'template',
              slug: 's',
              source: 'crawler',
              state: 'published',
              recentOrder: 500 + i,
            },
          },
          { upsert: true }
        )
      }
      const spy = vi
        .spyOn(Fetch, 'fetchOverleafPage')
        .mockImplementation(async href => ({
          status: 200,
          html: listingHtml(
            known.map(token => cardHtml(token)),
            1
          ),
          url: href,
        }))

      const scan = await MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 3,
        mode: 'incremental',
      })
      expect(scan.pages).toBe(1)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('identical concurrent recent scans share one run', async () => {
      let release
      const gate = new Promise(resolve => {
        release = resolve
      })
      const cards = [cardHtml(tokenOf('c', 0))]
      const spy = vi
        .spyOn(Fetch, 'fetchOverleafPage')
        .mockImplementation(async href => {
          await gate
          return { status: 200, html: listingHtml(cards, 1), url: href }
        })

      const first = MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 1,
        mode: 'incremental',
      })
      const second = MirrorService.scanGalleryRecent({
        fromPage: 1,
        toPage: 1,
        mode: 'incremental',
      })
      release()
      const [a, b] = await Promise.all([first, second])

      expect(spy).toHaveBeenCalledTimes(1)
      expect(a).toEqual(b)
    })
  })

  describe('PDF refused by the outbound allow-list', () => {
    const BLOCKED =
      'Outbound target blocked: writelatex.s3.amazonaws.com is not in template gallery allow-list'

    function blockedError() {
      const err = new Error(BLOCKED)
      err.code = OUTBOUND_BLOCKED
      return err
    }

    it('the official PDF fetch allows the signed S3 hop of its redirect chain', async () => {
      let captured = null
      Fetch.setFetchOverridesForTests({
        withHostSlot: (key, opts, fn) => fn(),
        fetchStream: async (url, opts) => {
          captured = opts
          throw new Error('stop after capturing the options')
        },
      })

      await rejectionOf(
        Fetch.storeOverleafPdf('/latex/templates/sample/abcdefghijkl')
      )
      expect(captured.allowedHosts).toEqual(
        expect.arrayContaining([
          'www.overleaf.com',
          'writelatex.s3.amazonaws.com',
        ])
      )
    })

    it('a blocked PDF is not escalated: its attempt count holds and it is retried hourly', async () => {
      await seedItem({
        mirror: {
          detailAt: new Date(),
          pdfAttempts: 3,
          pdfNextAttemptAt: PAST(),
        },
      })
      vi.spyOn(Fetch, 'storeOverleafPdf').mockRejectedValue(blockedError())

      expect(
        await MirrorService.ensurePdf(TOKEN, { priority: 'interactive' })
      ).toBeNull()

      const doc = await items.findOne({ token: TOKEN })
      expect(doc.mirror.pdfAttempts).toBe(3)
      expect(doc.mirror.pdfLastError).toContain('Outbound target blocked')
      const nextMs =
        new Date(doc.mirror.pdfNextAttemptAt).getTime() - Date.now()
      expect(nextMs).toBeGreaterThan(50 * 60_000)
      expect(nextMs).toBeLessThanOrEqual(60 * 60_000)
    })

    it('the one-time reset makes blocked PDFs due again, leaves other failures alone, and runs once', async () => {
      const blockedMsg = `EOUTBOUND_BLOCKED: ${BLOCKED}`
      await items.updateOne(
        { token: 'aaaaaaaaaaaa' },
        {
          $set: {
            token: 'aaaaaaaaaaaa',
            mirror: {
              pdfAttempts: 4,
              pdfNextAttemptAt: FUTURE(),
              pdfLastError: blockedMsg,
            },
          },
        },
        { upsert: true }
      )
      await items.updateOne(
        { token: 'bbbbbbbbbbbb' },
        {
          $set: {
            token: 'bbbbbbbbbbbb',
            mirror: {
              pdfAttempts: 4,
              pdfNextAttemptAt: FUTURE(),
              pdfLastError: 'PDF unavailable (HTTP 500)',
            },
          },
        },
        { upsert: true }
      )

      expect(await resetBlockedPdfBackoff()).toBe(1)
      const blocked = await items.findOne({ token: 'aaaaaaaaaaaa' })
      expect(blocked.mirror.pdfAttempts).toBe(0)
      expect(blocked.mirror.pdfNextAttemptAt).toBeNull()
      const other = await items.findOne({ token: 'bbbbbbbbbbbb' })
      expect(other.mirror.pdfAttempts).toBe(4)
      expect(new Date(other.mirror.pdfNextAttemptAt).getTime()).toBeGreaterThan(
        Date.now()
      )

      // Once the marker is written, a later blocked PDF is not reset again.
      await items.updateOne(
        { token: 'cccccccccccc' },
        {
          $set: {
            token: 'cccccccccccc',
            mirror: {
              pdfAttempts: 2,
              pdfNextAttemptAt: FUTURE(),
              pdfLastError: blockedMsg,
            },
          },
        },
        { upsert: true }
      )
      expect(await resetBlockedPdfBackoff()).toBe(0)
      expect(
        (await items.findOne({ token: 'cccccccccccc' })).mirror.pdfAttempts
      ).toBe(2)
    })
  })
})
