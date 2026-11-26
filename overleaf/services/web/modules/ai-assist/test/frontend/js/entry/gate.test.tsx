import { expect } from 'chai'
import { render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  lazyComponent,
  preloaded,
} from '../../../../frontend/js/features/ai-assist/entry/gate'
import { lazyExtension } from '../../../../frontend/js/features/ai-assist/entry/gate-extension'
import { isAvailable as writingToolsIsAvailable } from '../../../../frontend/js/features/ai-assist/entry/component-writing-tools-action'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'

// Other suites leave the flag in document.head as a <meta> tag, which getMeta
// falls back to when the cache has no entry. Clear it so each test sees only
// what it sets.
function clearHeadMeta() {
  document.head
    .querySelectorAll('meta[name="ol-aiAssistEnabled"]')
    .forEach(meta => meta.remove())
}

describe('ai-assist entry gate', function () {
  beforeEach(function () {
    resetMeta()
    clearHeadMeta()
  })

  afterEach(function () {
    resetMeta()
    clearHeadMeta()
  })

  describe('when disabled', function () {
    it('renders nothing and never runs the real component loader', function () {
      let loaded = false
      const Comp = lazyComponent(async () => {
        loaded = true
        return { default: () => null as any }
      })
      const { container } = render(<Comp />)
      expect(container.innerHTML).to.equal('')
      expect(loaded).to.equal(false)
    })

    it('returns an empty extension and never loads the real extension', function () {
      let loaded = false
      const ext = lazyExtension(async () => {
        loaded = true
        return []
      })
      expect(ext).to.deep.equal([])
      const state = EditorState.create({ extensions: [ext] })
      expect(state.doc.toString()).to.equal('')
      expect(loaded).to.equal(false)
    })

    it('does not start the preload and reports no value', function () {
      let loaded = false
      const get = preloaded(async () => {
        loaded = true
        return 'value'
      })
      expect(get()).to.equal(null)
      expect(loaded).to.equal(false)
    })

    it('reports writing tools as unavailable', function () {
      expect(writingToolsIsAvailable()).to.equal(false)
    })
  })

  describe('when enabled', function () {
    beforeEach(function () {
      window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    })

    it('swaps the real extension into the editor after loading', async function () {
      let calls = 0
      const ext = lazyExtension(async () => {
        calls++
        return EditorView.editable.of(false)
      })
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      const view = new EditorView({
        state: EditorState.create({ doc: 'x', extensions: [ext] }),
        parent,
      })
      expect(view.state.facet(EditorView.editable)).to.equal(true)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(calls).to.equal(1)
      expect(view.state.facet(EditorView.editable)).to.equal(false)
      view.destroy()
      parent.remove()
    })

    it('does not reconfigure the view if destroyed before extension resolves', async function () {
      let resolveExt!: (ext: ReturnType<typeof EditorView.editable.of>) => void
      const ext = lazyExtension(
        () =>
          new Promise(resolve => {
            resolveExt = resolve
          })
      )
      const parent = document.createElement('div')
      document.body.appendChild(parent)
      const view = new EditorView({
        state: EditorState.create({ doc: 'x', extensions: [ext] }),
        parent,
      })
      view.destroy()
      resolveExt(EditorView.editable.of(false))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(view.state.facet(EditorView.editable)).to.equal(true)
      parent.remove()
    })

    it('renders the loaded component and falls back silently on chunk failure', async function () {
      const Loaded = lazyComponent(async () => ({
        default: () => <span>ai-ok</span>,
      }))
      const okView = render(<Loaded />)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(okView.container.textContent).to.equal('ai-ok')

      const Broken = lazyComponent(async () => {
        throw new Error('chunk failed')
      })
      const brokenView = render(<Broken />)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(brokenView.container.textContent).to.equal('')
    })

    it('exposes a preloaded value once the chunk resolves and retries after error', async function () {
      let attempts = 0
      const retryGet = preloaded(async () => {
        attempts++
        if (attempts === 1) throw new Error('transient')
        return 'retried'
      })
      expect(retryGet()).to.equal(null)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(retryGet()).to.equal(null)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(retryGet()).to.equal('retried')
    })

    it('reports writing tools as available for a user with AI on', function () {
      expect(writingToolsIsAvailable()).to.equal(true)
    })
  })
})
