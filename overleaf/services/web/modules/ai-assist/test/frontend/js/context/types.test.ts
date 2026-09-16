import { expect } from 'chai'
import { fingerprintFiles } from '../../../../frontend/js/features/ai-assist/agent/context/types'
import type { ProjectFile } from '../../../../frontend/js/features/ai-assist/agent/project-handle'

const files: ProjectFile[] = [
  { path: 'main.tex', type: 'doc', size: 120, lines: 8 },
  { path: 'refs.bib', type: 'doc', size: 40, lines: 3 },
]

describe('fingerprintFiles', function () {
  it('is stable for the same listing', function () {
    expect(fingerprintFiles(files)).to.equal(fingerprintFiles(files))
  })

  it('ignores ordering, because the file tree does not promise one', function () {
    expect(fingerprintFiles(files)).to.equal(
      fingerprintFiles([...files].reverse())
    )
  })

  it('changes when a file is added', function () {
    const extra: ProjectFile[] = [
      ...files,
      { path: 'intro.tex', type: 'doc', size: 10, lines: 2 },
    ]
    expect(fingerprintFiles(extra)).to.not.equal(fingerprintFiles(files))
  })

  it('changes when a line count changes', function () {
    const grown: ProjectFile[] = [{ ...files[0], lines: 9 }, files[1]]
    expect(fingerprintFiles(grown)).to.not.equal(fingerprintFiles(files))
  })

  // Byte size churns on every keystroke. If it fed the fingerprint, the file
  // listing would re-render every turn and the cache would never hold.
  it('does not change when only the byte size changes', function () {
    const retyped: ProjectFile[] = [{ ...files[0], size: 121 }, files[1]]
    expect(fingerprintFiles(retyped)).to.equal(fingerprintFiles(files))
  })
})
