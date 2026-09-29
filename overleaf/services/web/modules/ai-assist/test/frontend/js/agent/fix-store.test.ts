import { expect } from 'chai'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  getStoredFix,
  saveStoredFix,
  clearFixStore,
  buildLogEntryFingerprint,
} from '../../../../frontend/js/features/ai-assist/agent/fix-store'

function makeFix(entryId: string, fingerprint: string) {
  return {
    entryId,
    fingerprint,
    open: true,
    collapsed: false,
    transcript: [],
    decidedEdits: {},
    updatedAt: Date.now(),
  }
}

describe('getStoredFix', function () {
  const projectId = 'proj-1'

  beforeEach(function () {
    clearFixStore()
    customLocalStorage.clear()
  })

  it('builds a fingerprint from file, line, and message so different problems never collide', function () {
    const undefinedControlSeq = buildLogEntryFingerprint({
      file: 'main.tex',
      line: 47,
      message: 'Undefined control sequence.',
    })
    const overfullHbox = buildLogEntryFingerprint({
      file: 'main.tex',
      line: 47,
      message: 'Overfull \\hbox (10pt too wide).',
    })

    expect(undefinedControlSeq).to.not.equal(overfullHbox)
  })

  it('returns the fix for a matching entryId when the fingerprint still matches', function () {
    saveStoredFix(projectId, makeFix('entry-1', 'main.tex:47:Undefined control sequence.'))

    const found = getStoredFix(
      projectId,
      'entry-1',
      'main.tex:47:Undefined control sequence.'
    )
    expect(found?.entryId).to.equal('entry-1')
  })

  it('does not return a stale fix when the log pane reuses an entryId for a different problem', function () {
    // The log pane can hand out the same `key` to a different error after a
    // recompile (e.g. a positional key). Storage must key off the actual
    // problem (file+line+message), not merely "this slot had a fix before".
    saveStoredFix(
      projectId,
      makeFix('entry-1', 'main.tex:47:Undefined control sequence.')
    )

    const found = getStoredFix(
      projectId,
      'entry-1',
      'main.tex:214:Overfull \\hbox (19.58pt too wide).'
    )
    expect(found).to.be.null
  })

  it('still finds a fix by fingerprint under a different entryId (aliasing)', function () {
    saveStoredFix(
      projectId,
      makeFix('entry-1', 'main.tex:47:Undefined control sequence.')
    )

    const found = getStoredFix(
      projectId,
      'entry-2',
      'main.tex:47:Undefined control sequence.'
    )
    expect(found?.fingerprint).to.equal('main.tex:47:Undefined control sequence.')
  })
})
