import http from 'node:http'
import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import {
  layoutText,
  pdfToText,
} from '../../../../app/src/web-fetch/extract/pdf.mjs'
import { documentFromResponse } from '../../../../app/src/web-fetch/document.mjs'
import {
  MAX_PDF_BYTES,
  fetchPublicUrl,
} from '../../../../app/src/web-fetch/transport.mjs'
import { PDF_LINE, makePdf } from './helpers/makePdf.mjs'

/** A pdf.js text item on its own line at baseline `y`. */
const item = (str, y, height = 10) => ({
  str,
  transform: [1, 0, 0, 1, 72, y],
  height,
  hasEOL: false,
})

describe('PDF layout', function () {
  it('joins lines into paragraphs and splits at a wide gap', function () {
    const [page] = layoutText([
      [
        item('First line of text', 700),
        item('continues here.', 688),
        item('New paragraph.', 660),
      ],
    ])
    expect(page).to.equal(
      'First line of text continues here.\n\nNew paragraph.'
    )
  })

  it('rejoins a word split by a line-end hyphen', function () {
    const [page] = layoutText([
      [item('The package is exam-', 700), item('ple of good design.', 688)],
    ])
    expect(page).to.equal('The package is example of good design.')
  })

  it('makes larger lines headings', function () {
    const [page] = layoutText([
      [
        item('Introduction', 720, 14),
        item('Body text of the first section.', 700),
        item('Details', 680, 11.8),
        item('More body text in this part.', 666),
      ],
    ])
    expect(page).to.equal(
      '## Introduction\n\nBody text of the first section.\n\n### Details\n\nMore body text in this part.'
    )
  })

  it('removes running headers and page numbers', function () {
    const pages = ['alpha', 'beta', 'gamma'].map((word, index) => [
      item('Journal of Typesetting 12', 760),
      item(`Body about ${word} with enough words.`, 700),
      item(`More about ${word} on this page here.`, 688),
      item(String(index + 1), 40),
    ])
    expect(layoutText(pages)).to.deep.equal([
      'Body about alpha with enough words. More about alpha on this page here.',
      'Body about beta with enough words. More about beta on this page here.',
      'Body about gamma with enough words. More about gamma on this page here.',
    ])
  })

  // Review Focus 4
  it('keeps repeated lines on short pages', function () {
    const pages = ['alpha', 'beta', 'gamma'].map(word => [
      item('Course slides', 700),
      item(`Point about ${word}.`, 680),
    ])
    expect(layoutText(pages)).to.deep.equal([
      'Course slides Point about alpha.',
      'Course slides Point about beta.',
      'Course slides Point about gamma.',
    ])
  })
})

const lookupToServer = (_host, options, callback) =>
  options?.all
    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
    : callback(null, '127.0.0.1', 4)

describe('PDF reading', function () {
  it('extracts each page under a page marker, with the title', async function () {
    const pdf = makePdf(
      [`${PDF_LINE}\nSecond line of page one.`, `${PDF_LINE} Page two.`],
      'siunitx manual'
    )
    const { title, text, truncated } = await pdfToText(pdf)
    expect(title).to.equal('siunitx manual')
    expect(truncated).to.equal(false)
    expect(text).to.include(
      `--- PDF page 1 ---\n${PDF_LINE} Second line of page one.`
    )
    expect(text).to.include(`--- PDF page 2 ---\n${PDF_LINE} Page two.`)
  })

  it('stops at the page cap and says so', async function () {
    const pdf = makePdf([PDF_LINE, PDF_LINE, PDF_LINE])
    const { text, truncated } = await pdfToText(pdf, { maxPages: 2 })
    expect(truncated).to.equal(true)
    expect(text).to.include('--- PDF page 2 ---')
    expect(text).not.to.include('--- PDF page 3 ---')
  })

  it('explains a PDF with no text layer', async function () {
    let error
    try {
      await pdfToText(makePdf(['', '']), { url: 'https://x.org/scan.pdf' })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('content')
    expect(error?.message).to.match(/scan\.pdf is a PDF with no text layer/)
  })

  it('explains a file that is not a PDF at all', async function () {
    let error
    try {
      await pdfToText(Buffer.from('%PDF-1.7 garbage'), {
        url: 'https://x.org/a.pdf',
      })
    } catch (err) {
      error = err
    }
    expect(error?.kind).to.equal('content')
    expect(error?.message).to.match(/could not be read as a PDF/)
  })

  it('reads a PDF through documentFromResponse', async function () {
    const doc = await documentFromResponse({
      url: 'https://x.org/manual.pdf',
      contentType: 'application/pdf',
      body: makePdf([PDF_LINE, PDF_LINE], 'Manual'),
    })
    expect(doc.title).to.equal('Manual')
    expect(doc.text).to.include('--- PDF page 1 ---')
  })

  // Review Focus 2
  it('reads a PDF served as octet-stream', async function () {
    const doc = await documentFromResponse({
      url: 'https://x.org/download?id=7',
      contentType: 'application/octet-stream',
      body: makePdf([PDF_LINE, PDF_LINE]),
    })
    expect(doc.text).to.include(PDF_LINE)
  })

  describe('download cap', function () {
    let server
    let port
    const big = Buffer.alloc(6 * 1024 * 1024, 'a')

    beforeEach(async function () {
      server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type':
            req.url === '/doc.pdf' ? 'application/pdf' : 'text/html',
        })
        res.end(big)
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      port = server.address().port
    })

    afterEach(function () {
      server.close()
    })

    it('downloads files under the default caps whole, and honors explicit caps when given', async function () {
      expect(MAX_PDF_BYTES).to.equal(128 * 1024 * 1024)
      const pdf = await fetchPublicUrl(
        `http://files.example.test:${port}/doc.pdf`,
        {
          lookup: lookupToServer,
        }
      )
      expect(pdf.truncated).to.equal(false)
      expect(pdf.body.length).to.equal(big.length)
      const page = await fetchPublicUrl(
        `http://files.example.test:${port}/page`,
        {
          lookup: lookupToServer,
        }
      )
      expect(page.truncated).to.equal(false)
      expect(page.body.length).to.equal(big.length)

      const capped = await fetchPublicUrl(
        `http://files.example.test:${port}/page`,
        {
          lookup: lookupToServer,
          maxBytes: 1024 * 1024,
        }
      )
      expect(capped.truncated).to.equal(true)
      expect(capped.body.length).to.equal(1024 * 1024)
    })
  })
})
