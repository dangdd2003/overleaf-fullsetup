import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import * as Planner from '../../../app/src/storage/DuplicatePlanner.mjs'

const sha = text => crypto.createHash('sha256').update(text).digest('hex')

// A small PDF whose volatile metadata can be varied independently of its body
function fakePdf({ created = 'D:20240101000000Z', modified = created, id = 'a1b2', xmpDate = '2024-01-01T00:00:00Z', body = 'BT (Hello) Tj ET' } = {}) {
  return Buffer.from(
    [
      '%PDF-1.4',
      `1 0 obj << /Title (T) /CreationDate (${created}) /ModDate (${modified}) /Producer (x) >> endobj`,
      `2 0 obj << /Length ${body.length} >> stream`,
      'xmp <xmp:CreateDate>' + xmpDate + '</xmp:CreateDate> <xmp:ModifyDate ver="1">' + xmpDate + '</xmp:ModifyDate>',
      'xmpMM:DocumentID="uuid:' + id + '" xmpMM:InstanceID="uuid:' + id + '"',
      body,
      'endstream endobj',
      `trailer << /ID [<${id}> <${id}>] /Root 1 0 R >>`,
      '%%EOF',
      '',
    ].join('\n'),
    'latin1'
  )
}

const ref = (sha256, extra = {}) => ({ sha256, ...extra })

function item(token, overrides = {}) {
  return {
    _id: `id-${token}`,
    token,
    title: 'Résumé Template!',
    state: 'published',
    family: 'templates',
    slug: `slug-${token}`,
    duplicateOf: null,
    mirror: { removedAt: null },
    media: {},
    dedup: {},
    tags: [],
    stats: { opens: 0 },
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

const P1 = sha('pdf-one')
const P2 = sha('pdf-two')
const I1 = sha('image-one')
const I2 = sha('image-two')

describe('S-P7 PDF normalization', () => {
  it('treats PDFs that differ only in dates, trailer id and XMP ids as the same', () => {
    const a = fakePdf({ created: 'D:20240101000000Z', id: 'a1b2', xmpDate: '2024-01-01T00:00:00Z' })
    const b = fakePdf({ created: 'D:20240101000000Z', modified: 'D:20260303101010Z', id: 'ffee', xmpDate: '2026-03-03T10:10:10Z' })
    expect(sha(a)).not.toBe(sha(b))
    expect(Planner.pdfNormSha(a)).toBe(Planner.pdfNormSha(b))
  })

  it('keeps PDFs with different content apart', () => {
    const a = fakePdf({ body: 'BT (Hello) Tj ET' })
    const b = fakePdf({ body: 'BT (Goodbye) Tj ET' })
    expect(Planner.pdfNormSha(a)).not.toBe(Planner.pdfNormSha(b))
  })

  it('normalizes a PDF with many unclosed XMP elements in linear time', () => {
    // 200k openers with no closer: a lazy regex would scan to the end for each one
    const pdf = Buffer.from('%PDF-1.4\n' + '<xmp:CreateDate>'.repeat(200000) + '\n%%EOF')
    const started = Date.now()
    const out = Planner.normalizePdf(pdf)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out.toString('latin1')).toBe(pdf.toString('latin1'))
  })

  it('still removes a closed XMP element that follows an unclosed one', () => {
    const pdf = Buffer.from('<xmp:CreateDate>x<xmp:ModifyDate>y</xmp:ModifyDate>')
    expect(Planner.normalizePdf(pdf).toString('latin1')).toBe('<xmp:CreateDate>x')
  })
})

describe('S-P7 title normalization', () => {
  it('lowercases, drops accents and punctuation, and returns null for empty titles', () => {
    expect(Planner.normalizeTitle('  Résumé — Template!  ')).toBe('resume template')
    expect(Planner.normalizeTitle('Résumé template')).toBe('resume template')
    expect(Planner.normalizeTitle('')).toBeNull()
    expect(Planner.normalizeTitle(null)).toBeNull()
  })
})

describe('S-P7 duplicate grouping', () => {
  it('groups items with the same PDF, the same normalized PDF, or the same preview and title', () => {
    const items = [
      item('aaaaaaaaaaaa', { media: { pdfSha: P1 } }),
      item('bbbbbbbbbbbb', { media: { pdfSha: P1 } }),
      item('cccccccccccc', { dedup: { pdfNormSha: P2 }, media: { pdfSha: sha('x') } }),
      item('dddddddddddd', { dedup: { pdfNormSha: P2 }, media: { pdfSha: sha('y') } }),
      item('eeeeeeeeeeee', { media: { previewSha: I1 }, title: 'Annual Market Report' }),
      item('ffffffffffff', { media: { previewSha: I1 }, title: 'annual market report' }),
      item('gggggggggggg', { media: { previewSha: I2 }, title: 'Annual Market Report' }),
    ]
    const groups = Planner.groupDuplicates(items)
    const tokenSets = groups.map(g => g.members.map(m => m.token).sort())
    expect(tokenSets).toEqual([
      ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
      ['cccccccccccc', 'dddddddddddd'],
      ['eeeeeeeeeeee', 'ffffffffffff'],
    ])
    expect(groups.find(g => g.members[0].token === 'aaaaaaaaaaaa').reasons).toEqual(['same_pdf'])
    expect(groups.find(g => g.members[0].token === 'cccccccccccc').reasons).toEqual(['same_normalized_pdf'])
    expect(groups.find(g => g.members[0].token === 'eeeeeeeeeeee').reasons).toEqual(['same_preview_and_title'])
  })

  it('does not link same-preview items with different titles', () => {
    const items = [
      item('aaaaaaaaaaaa', { media: { previewSha: I1 }, title: 'Alpha' }),
      item('bbbbbbbbbbbb', { media: { previewSha: I1 }, title: 'Beta' }),
    ]
    expect(Planner.groupDuplicates(items)).toEqual([])
  })

  it('does not merge different templates with byte-identical PDFs when their titles differ', () => {
    const items = [
      item('aaaaaaaaaaaa', { media: { pdfSha: P1 }, title: 'Thesis Template' }),
      item('bbbbbbbbbbbb', { media: { pdfSha: P1 }, title: 'Cover Letter' }),
    ]
    expect(Planner.groupDuplicates(items)).toEqual([])
  })

  it('does not merge same normalized PDFs across families or without a title', () => {
    const items = [
      item('aaaaaaaaaaaa', { dedup: { pdfNormSha: P2 }, family: 'templates' }),
      item('bbbbbbbbbbbb', { dedup: { pdfNormSha: P2 }, family: 'examples' }),
      item('cccccccccccc', { media: { pdfSha: P1 }, title: '' }),
      item('dddddddddddd', { media: { pdfSha: P1 }, title: '' }),
    ]
    expect(Planner.groupDuplicates(items)).toEqual([])
  })

  it('never groups on a generic preview and title alone', () => {
    const items = [
      // two-word title: too generic to link on a shared preview
      item('aaaaaaaaaaaa', { media: { previewSha: I1 }, title: 'Resume Template' }),
      item('bbbbbbbbbbbb', { media: { previewSha: I1 }, title: 'Resume Template' }),
    ]
    expect(Planner.groupDuplicates(items)).toEqual([])
  })

  it('ignores a placeholder preview shared by many items', () => {
    const placeholder = sha('placeholder-preview')
    const items = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'].map(token =>
      item(token, { media: { previewSha: placeholder }, title: 'Curriculum Vitae Template' })
    )
    expect(Planner.groupDuplicates(items)).toEqual([])
  })

  it('joins chains of links into one group (union-find)', () => {
    // a-b share a PDF, b-c share a normalized PDF: one group of three
    const items = [
      item('aaaaaaaaaaaa', { media: { pdfSha: P1 } }),
      item('bbbbbbbbbbbb', { media: { pdfSha: P1 }, dedup: { pdfNormSha: P2 } }),
      item('cccccccccccc', { dedup: { pdfNormSha: P2 } }),
    ]
    const groups = Planner.groupDuplicates(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toHaveLength(3)
  })

  it('leaves out unpublished, removed, tombstoned and kept items', () => {
    const items = [
      item('aaaaaaaaaaaa', { media: { pdfSha: P1 } }),
      item('bbbbbbbbbbbb', { media: { pdfSha: P1 }, state: 'unpublished' }),
      item('cccccccccccc', { media: { pdfSha: P1 }, mirror: { removedAt: new Date() } }),
      item('dddddddddddd', { media: { pdfSha: P1 }, duplicateOf: 'aaaaaaaaaaaa' }),
      item('eeeeeeeeeeee', { media: { pdfSha: P1 }, dedup: { keep: true } }),
      item('ffffffffffff', { media: { pdfSha: 'not-a-sha' } }),
    ]
    expect(Planner.groupDuplicates(items)).toEqual([])
  })
})

describe('S-P7 canonical choice', () => {
  it('prefers featured, then a source package, then more tags, more opens, oldest, token', () => {
    const feat = item('ffffffffffff', { createdAt: '2025-01-01T00:00:00Z' })
    const sourced = item('aaaaaaaaaaaa', { sourceAcquired: true, createdAt: '2020-01-01T00:00:00Z' })
    const tagged = item('bbbbbbbbbbbb', { tags: [{ name: 'a' }, { name: 'b' }], createdAt: '2020-01-01T00:00:00Z' })
    const opened = item('cccccccccccc', { stats: { opens: 9 }, createdAt: '2020-01-01T00:00:00Z' })
    const old = item('dddddddddddd', { createdAt: '2019-01-01T00:00:00Z' })
    const sorted = (members, featured = new Set()) => Planner.sortCanonical(members, featured).map(m => m.token)
    expect(sorted([sourced, feat], new Set(['ffffffffffff']))[0]).toBe('ffffffffffff')
    expect(sorted([tagged, sourced])[0]).toBe('aaaaaaaaaaaa')
    expect(sorted([opened, tagged])[0]).toBe('bbbbbbbbbbbb')
    expect(sorted([opened, old])[0]).toBe('cccccccccccc')
    const same1 = item('bbbbbbbbbbbb', { createdAt: '2020-01-01T00:00:00Z' })
    const same2 = item('aaaaaaaaaaaa', { createdAt: '2020-01-01T00:00:00Z' })
    expect(sorted([same1, same2])[0]).toBe('aaaaaaaaaaaa')
  })
})

describe('S-P7 tombstone plan', () => {
  it('unsets only the blob refs the canonical does not share', () => {
    const canonical = item('aaaaaaaaaaaa', { media: { pdfSha: P1, thumbSha: I1, previewSha: I1 } })
    const dup = item('bbbbbbbbbbbb', {
      media: { pdfSha: P1, thumbSha: I2, previewSha: I2, pdfBytes: 5 },
      pdfBlobStoreKey: I2,
    })
    const tb = Planner.buildTombstone(canonical, dup)
    expect(tb.token).toBe('bbbbbbbbbbbb')
    // same pdf is kept; the image differs and the legacy pdf key too
    expect(tb.keepShas).toEqual([P1])
    expect(tb.unset).toHaveProperty('media.thumbSha', '')
    expect(tb.unset).toHaveProperty('media.previewSha', '')
    expect(tb.unset).toHaveProperty('pdfBlobStoreKey', '')
    expect(tb.unset).not.toHaveProperty('media.pdfSha')
    expect(tb.dropShas.sort()).toEqual([I2].sort())
  })

  it('clears the source package as a whole when its blob differs', () => {
    const S1 = sha('source-one')
    const S2 = sha('source-two')
    const canonical = item('aaaaaaaaaaaa', { sourceBlobStoreKey: S1, zip: { sha256: S1 } })
    const dup = item('bbbbbbbbbbbb', { sourceBlobStoreKey: S2, zip: { sha256: S2 }, sourceAcquired: true, acquisitionTier: 1 })
    const tb = Planner.buildTombstone(canonical, dup)
    expect(tb.unset).toMatchObject({ sourceBlobStoreKey: '', 'zip.sha256': '', sourceAcquired: '', acquisitionTier: '' })
    expect(tb.dropShas).toEqual([S2])
  })

  it('plans the duplicates of each group and merges missing tags into the canonical', () => {
    const items = [
      // equal tag counts: the one with more opens is canonical
      item('aaaaaaaaaaaa', { media: { pdfSha: P1 }, tags: [{ name: 'cv' }], stats: { opens: 5 } }),
      item('bbbbbbbbbbbb', { media: { pdfSha: P1 }, tags: [{ name: 'resume', title: 'Resume' }], stats: { opens: 1 } }),
    ]
    const plan = Planner.planDedup(items)
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].canonical).toBe('aaaaaaaaaaaa')
    expect(plan.groups[0].duplicates).toEqual(['bbbbbbbbbbbb'])
    expect(plan.groups[0].tagsToAdd).toEqual([{ name: 'resume', title: 'Resume' }])
    expect(plan.tombstones).toBe(1)
  })
})
