import { expect } from 'chai'
import {
  createSnapshotGate,
  SnapshotUnavailableError,
  filesFromFileTree,
} from '../../../../frontend/js/features/ai-assist/agent/snapshot-gate'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSnapshotGate', function () {
  it('refreshes before the first read', async function () {
    let calls = 0
    const gate = createSnapshotGate(async () => {
      calls += 1
    })

    await gate.ensure()

    expect(calls).to.equal(1)
  })

  it('reuses a fresh snapshot instead of refreshing per read', async function () {
    let calls = 0
    const gate = createSnapshotGate(async () => {
      calls += 1
    })

    await gate.ensure()
    await gate.ensure()
    await gate.ensure()

    expect(calls).to.equal(1)
  })

  it('refreshes again once the snapshot has aged out', async function () {
    let calls = 0
    let clock = 1000
    const gate = createSnapshotGate(
      async () => {
        calls += 1
      },
      { ttlMs: 5000, now: () => clock }
    )

    await gate.ensure()
    clock += 6000
    await gate.ensure()

    expect(calls).to.equal(2)
  })

  it('shares one refresh between concurrent reads', async function () {
    let calls = 0
    const pending = deferred()
    const gate = createSnapshotGate(async () => {
      calls += 1
      await pending.promise
    })

    const reads = [gate.ensure(), gate.ensure(), gate.ensure()]
    pending.resolve()
    await Promise.all(reads)

    expect(calls).to.equal(1)
  })

  it('refreshes again after an edit invalidates the snapshot', async function () {
    let calls = 0
    const gate = createSnapshotGate(async () => {
      calls += 1
    })

    await gate.ensure()
    gate.invalidate()
    await gate.ensure()

    expect(calls).to.equal(2)
  })

  // The bug this whole gate exists for: a failed refresh used to leave the
  // snapshot empty, and the read tools reported that as an empty project.
  it('rejects rather than letting a read see an empty project', async function () {
    const gate = createSnapshotGate(async () => {
      throw new Error('Internal Server Error')
    })

    let caught: unknown
    try {
      await gate.ensure()
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.an.instanceOf(SnapshotUnavailableError)
  })

  it('names the underlying failure so the cause is visible', async function () {
    const gate = createSnapshotGate(async () => {
      throw new Error('Internal Server Error')
    })

    let message = ''
    try {
      await gate.ensure()
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).to.contain('Internal Server Error')
    expect(message).to.contain('do not treat the project as empty')
  })

  it('does not cache a failure, so a later read can recover', async function () {
    let calls = 0
    const gate = createSnapshotGate(async () => {
      calls += 1
      if (calls === 1) throw new Error('Internal Server Error')
    })

    await gate.ensure().catch(() => {})
    await gate.ensure()

    expect(calls).to.equal(2)
  })

  it('keeps failing while the refresh keeps failing', async function () {
    const gate = createSnapshotGate(async () => {
      throw new Error('Internal Server Error')
    })

    await gate.ensure().catch(() => {})

    let caught: unknown
    try {
      await gate.ensure()
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.an.instanceOf(SnapshotUnavailableError)
  })

  it('is a no-op when the snapshot cannot refresh at all', async function () {
    const gate = createSnapshotGate(undefined)

    await gate.ensure()
  })

  describe('filesFromFileTree', function () {
    it('returns empty array when folder is null or undefined', function () {
      expect(filesFromFileTree(null)).to.deep.equal([])
      expect(filesFromFileTree(undefined)).to.deep.equal([])
    })

    it('traverses nested folders and preserves relative paths', function () {
      const folderTree = {
        name: 'root',
        docs: [{ name: 'main.tex' }, { name: 'references.bib' }],
        fileRefs: [{ name: 'figure1.png' }],
        folders: [
          {
            name: 'sections',
            docs: [{ name: 'intro.tex' }],
            fileRefs: [],
            folders: [
              {
                name: 'sub',
                docs: [{ name: 'details.tex' }],
                fileRefs: [{ name: 'diagram.pdf' }],
              },
            ],
          },
        ],
      }

      const files = filesFromFileTree(folderTree)

      expect(files).to.deep.equal([
        { path: 'main.tex', type: 'doc', size: 0 },
        { path: 'references.bib', type: 'doc', size: 0 },
        { path: 'figure1.png', type: 'binary', size: 0 },
        { path: 'sections/intro.tex', type: 'doc', size: 0 },
        { path: 'sections/sub/details.tex', type: 'doc', size: 0 },
        { path: 'sections/sub/diagram.pdf', type: 'binary', size: 0 },
      ])
    })
  })
})
