import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import {
  AiAssistLanguageCheckStore,
  normalizeEntry,
  MAX_ENTRIES,
} from '../../../app/src/AiAssistLanguageCheckStore.mjs'
import { AiAssistLanguageCheckController } from '../../../app/src/AiAssistLanguageCheckController.mjs'

const PROJECT = '0123456789abcdef01234567'
const EDIT = { from: 4, to: 9, original: 'shows', insert: 'show' }

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code
      return res
    },
    json(body) {
      res.body = body
      return res
    },
    sendStatus(code) {
      res.statusCode = code
      return res
    },
  }
  return res
}

describe('AiAssistLanguageCheckStore', function () {
  let dir, previous

  beforeEach(async function () {
    dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ai-language-checks-'))
    Settings.aiAssist = Settings.aiAssist || {}
    previous = Settings.aiAssist.chatHistoryDir
    Settings.aiAssist.chatHistoryDir = dir
  })

  afterEach(async function () {
    Settings.aiAssist.chatHistoryDir = previous
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('finds what was stored, and only that, after a write and a fresh read', async function () {
    const store = new AiAssistLanguageCheckStore()
    await store.store(PROJECT, [
      { key: 'k1', entry: { edits: [EDIT], text: 'The results shows.' } },
      { key: 'k2', entry: { edits: [] } },
    ])
    expect(await store.lookup(PROJECT, ['k1', 'k3'])).to.deep.equal({
      k1: { edits: [EDIT], text: 'The results shows.' },
    })
    await store.flush(PROJECT)
    const fresh = new AiAssistLanguageCheckStore()
    expect(await fresh.lookup(PROJECT, ['k1', 'k2'])).to.deep.equal({
      k1: { edits: [EDIT], text: 'The results shows.' },
      k2: { edits: [] },
    })
  })

  it('writes the saves of one check together', async function () {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const store = new AiAssistLanguageCheckStore()
      const write = sinon.spy(fs, 'writeFile')
      await store.store(PROJECT, [{ key: 'a', entry: { edits: [] } }])
      await store.store(PROJECT, [{ key: 'b', entry: { edits: [] } }])
      expect(write.callCount).to.equal(0)
      await store.flush(PROJECT)
      expect(write.callCount).to.equal(1)
      write.restore()
    } finally {
      clock.restore()
    }
  })

  it(`keeps the newest ${MAX_ENTRIES} results`, async function () {
    const store = new AiAssistLanguageCheckStore()
    const items = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ key: `k${i}`, entry: { edits: [] } }))
    for (let i = 0; i < items.length; i += 1000) await store.store(PROJECT, items.slice(i, i + 1000))
    expect(await store.lookup(PROJECT, ['k0', 'k4', 'k5', `k${MAX_ENTRIES + 4}`])).to.have.all.keys('k5', `k${MAX_ENTRIES + 4}`)
  })

  it('keeps whether an edit is a correction or a style suggestion, and nothing else', function () {
    const entry = normalizeEntry({
      edits: [
        { from: 0, to: 3, insert: 'Two', original: 'One', kind: 'style', extra: 1 },
        { from: 4, to: 5, insert: 'b', original: 'a', kind: 'other' },
      ],
    })
    expect(entry.edits).to.deep.equal([
      { from: 0, to: 3, insert: 'Two', original: 'One', kind: 'style' },
      { from: 4, to: 5, insert: 'b', original: 'a' },
    ])
  })

  it('rejects a bad project id', async function () {
    const store = new AiAssistLanguageCheckStore()
    let error
    try {
      await store.lookup('../etc', ['k'])
    } catch (err) {
      error = err
    }
    expect(error).to.be.instanceOf(Error)
  })

  describe('controller', function () {
    it('looks up and stores through the store', async function () {
      const store = {
        lookup: sinon.stub().resolves({ k: { edits: [] } }),
        store: sinon.stub().resolves(),
      }
      const controller = new AiAssistLanguageCheckController({ store })
      const res = fakeRes()
      await controller.lookup({ params: { Project_id: PROJECT }, body: { keys: ['k'] } }, res)
      expect(res.body).to.deep.equal({ entries: { k: { edits: [] } } })

      const saved = fakeRes()
      await controller.save(
        {
          params: { Project_id: PROJECT },
          body: { entries: [{ key: 'k', entry: { edits: [EDIT], text: 'x', rejected: [EDIT] } }] },
        },
        saved
      )
      expect(saved.statusCode).to.equal(204)
      // Only the shared parts are kept
      expect(store.store.firstCall.args[1]).to.deep.equal([{ key: 'k', entry: { edits: [EDIT], text: 'x' } }])
    })

    it('refuses malformed or oversized requests', async function () {
      const store = { lookup: sinon.stub(), store: sinon.stub() }
      const controller = new AiAssistLanguageCheckController({ store })
      for (const body of [{}, { keys: 'k' }, { keys: [1] }, { keys: Array(501).fill('k') }]) {
        const res = fakeRes()
        await controller.lookup({ params: { Project_id: PROJECT }, body }, res)
        expect(res.statusCode).to.equal(400)
      }
      for (const entries of [
        'x',
        [{ key: 'k', entry: { edits: 'no' } }],
        [{ key: '', entry: { edits: [] } }],
        [{ key: 'k', entry: { edits: [{ from: -1, to: 0, insert: '', original: '' }] } }],
        Array(101).fill({ key: 'k', entry: { edits: [] } }),
      ]) {
        const res = fakeRes()
        await controller.save({ params: { Project_id: PROJECT }, body: { entries } }, res)
        expect(res.statusCode).to.equal(400)
      }
      expect(store.lookup.called || store.store.called).to.equal(false)
    })
  })
})
