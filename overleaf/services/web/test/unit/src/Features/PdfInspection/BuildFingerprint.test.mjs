import { describe, it, expect } from 'vitest'

const {
  buildFingerprint,
  diffFingerprints,
  digestContent,
} = await import('../../../../../app/src/Features/PdfInspection/BuildFingerprint.mjs')

function base(overrides = {}) {
  return buildFingerprint({
    rootDocPath: 'main.tex',
    compiler: 'pdflatex',
    imageName: 'texlive-full:2025',
    entries: [
      { path: 'main.tex', digest: 'a' },
      { path: 'chapters/intro.tex', digest: 'b' },
      { path: 'figs/plot.png', digest: 'file-1' },
    ],
    ...overrides,
  })
}

describe('BuildFingerprint', () => {
  describe('buildFingerprint', () => {
    it('is independent of entry order', () => {
      const reversed = buildFingerprint({
        rootDocPath: 'main.tex',
        compiler: 'pdflatex',
        imageName: 'texlive-full:2025',
        entries: [
          { path: 'figs/plot.png', digest: 'file-1' },
          { path: 'chapters/intro.tex', digest: 'b' },
          { path: 'main.tex', digest: 'a' },
        ],
      })
      expect(reversed.contentHash).toBe(base().contentHash)
    })

    it('strips a leading slash from paths', () => {
      const slashed = buildFingerprint({
        rootDocPath: 'main.tex',
        entries: [{ path: '/main.tex', digest: 'x' }],
      })
      const plain = buildFingerprint({
        rootDocPath: 'main.tex',
        entries: [{ path: 'main.tex', digest: 'x' }],
      })
      expect(slashed.contentHash).toBe(plain.contentHash)
      expect(slashed.entries[0].path).toBe('main.tex')
    })

    it('changes the hash when any input changes', () => {
      const hash = base().contentHash
      expect(base({ compiler: 'lualatex' }).contentHash).not.toBe(hash)
      expect(base({ imageName: 'texlive:2024' }).contentHash).not.toBe(hash)
      expect(base({ rootDocPath: 'other.tex' }).contentHash).not.toBe(hash)
    })

    it('defaults missing inputs to null without throwing', () => {
      const empty = buildFingerprint()
      expect(empty.rootDocPath).toBeNull()
      expect(empty.compiler).toBeNull()
      expect(empty.entries).toEqual([])
      expect(typeof empty.contentHash).toBe('string')
    })
  })

  describe('diffFingerprints', () => {
    it('returns null when nothing changed', () => {
      expect(diffFingerprints(base(), base())).toBeNull()
    })

    it('returns null when either side is missing', () => {
      expect(diffFingerprints(null, base())).toBeNull()
      expect(diffFingerprints(base(), undefined)).toBeNull()
    })

    it('reports docs_changed with the edited path', () => {
      const current = base({
        entries: [
          { path: 'main.tex', digest: 'a' },
          { path: 'chapters/intro.tex', digest: 'CHANGED' },
          { path: 'figs/plot.png', digest: 'file-1' },
        ],
      })
      expect(diffFingerprints(base(), current)).toEqual({
        reason: 'docs_changed',
        changed: ['chapters/intro.tex'],
      })
    })

    it('reports added and removed paths as changed', () => {
      const current = base({
        entries: [
          { path: 'main.tex', digest: 'a' },
          { path: 'chapters/new.tex', digest: 'n' },
        ],
      })
      const diff = diffFingerprints(base(), current)
      expect(diff.reason).toBe('docs_changed')
      expect(diff.changed).toEqual([
        'chapters/intro.tex',
        'chapters/new.tex',
        'figs/plot.png',
      ])
    })

    it('reports compiler_changed when the compiler or image differs', () => {
      const compiler = diffFingerprints(
        base(),
        base({ compiler: 'lualatex' })
      )
      expect(compiler.reason).toBe('compiler_changed')
      const image = diffFingerprints(
        base(),
        base({ imageName: 'texlive:2024' })
      )
      expect(image.reason).toBe('compiler_changed')
    })

    it('reports root_changed when the root document differs', () => {
      const diff = diffFingerprints(base(), base({ rootDocPath: 'other.tex' }))
      expect(diff.reason).toBe('root_changed')
    })

    it('prefers root_changed over compiler_changed over docs_changed', () => {
      const diff = diffFingerprints(
        base(),
        base({
          rootDocPath: 'other.tex',
          compiler: 'lualatex',
          entries: [{ path: 'x.tex', digest: 'z' }],
        })
      )
      expect(diff.reason).toBe('root_changed')
    })

    it('lists every changed path', () => {
      const many = Array.from({ length: 25 }, (_, i) => ({
        path: `s${String(i).padStart(2, '0')}.tex`,
        digest: 'd',
      }))
      const diff = diffFingerprints(
        base({ entries: [] }),
        base({ entries: many })
      )
      expect(diff.changed).toHaveLength(25)
      expect(diff.changed[0]).toBe('s00.tex')
      expect(diff.changed.at(-1)).toBe('s24.tex')
    })
  })

  describe('digestContent', () => {
    it('is a stable hex sha256', () => {
      expect(digestContent('abc')).toMatch(/^[0-9a-f]{64}$/)
      expect(digestContent('abc')).toBe(digestContent('abc'))
      expect(digestContent('abc')).not.toBe(digestContent('abd'))
    })
  })
})
