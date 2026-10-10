import { expect } from 'chai'
import { ReactNode, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  CodeMirrorStateContext,
  CodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import type { Permissions } from '@/features/ide-react/types/permissions'
import WritingToolsAction, {
  isAvailable,
} from '../../../../frontend/js/features/ai-assist/components/writing-tools/writing-tools-action'
import WritingToolsCard from '../../../../frontend/js/features/ai-assist/components/writing-tools/writing-tools-card'
import {
  openWritingSession,
  writingSessionField,
  writingToolsExtension,
} from '../../../../frontend/js/features/ai-assist/writing-tools/extension'
import { WritingActionId } from '../../../../frontend/js/features/ai-assist/writing-tools/actions'
import {
  clearSelectionHistory,
  saveWritingToolHistory,
} from '../../../../frontend/js/features/ai-assist/writing-tools/history-cache'

const CHAT = '/ai-assist/providers/editor'

const WRITE: Permissions = {
  read: true,
  comment: true,
  resolveOwnComments: true,
  resolveAllComments: true,
  trackedWrite: true,
  write: true,
  admin: false,
  labelVersion: true,
}

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }]
      .map(c => JSON.stringify(c) + '\n')
      .join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

/** A real EditorView whose state reaches React the way the editor does it. */
function renderEditor(
  doc: string,
  selection: { from: number; to: number },
  ui: ReactNode,
  permissions: Permissions = WRITE
) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  let publish: (state: EditorState) => void = () => {}
  const view: EditorView = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(selection.from, selection.to),
      extensions: writingToolsExtension(),
    }),
    parent,
    dispatchTransactions: transactions => {
      view.update(transactions)
      publish(view.state)
    },
  })

  function Harness() {
    const [state, setState] = useState(view.state)
    publish = setState
    return (
      <CodeMirrorViewContext.Provider value={view}>
        <CodeMirrorStateContext.Provider value={state}>
          <PermissionsContext.Provider value={permissions}>
            {ui}
          </PermissionsContext.Provider>
        </CodeMirrorStateContext.Provider>
      </CodeMirrorViewContext.Provider>
    )
  }

  render(<Harness />)
  return view
}

function openSession(
  view: EditorView,
  from: number,
  to: number,
  action: WritingActionId = 'rephrase',
  targetLanguage?: string
) {
  view.dispatch({
    effects: openWritingSession.of({ from, to, action, targetLanguage }),
  })
}

describe('writing tools: components', function () {
  beforeEach(function () {
    clearSelectionHistory()
    setMeta()
    document.body.innerHTML = ''
    customLocalStorage.clear()
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude',
    })
    customLocalStorage.setItem('ai-assist:consent', true)
    fetchMock.removeRoutes().clearHistory()
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    clearSelectionHistory()
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  describe('selection box row', function () {
    it('is available only when AI is enabled and not turned off', function () {
      expect(isAvailable()).to.equal(true)
      setMeta({ enabled: false })
      expect(isAvailable()).to.equal(false)
    })

    it('lists word tools for a short selection and opens a session', async function () {
      const doc = 'We saw a quick result.'
      const view = renderEditor(doc, { from: 9, to: 14 }, <WritingToolsAction />)
      fireEvent.click(screen.getByRole('button', { name: /Writing tools/ }))
      const items = screen
        .getAllByRole('menuitem')
        .map(i => i.querySelector('.ai-texgpt-menu-item-label')?.textContent)
      expect(items).to.deep.equal(['Synonyms', 'Translate', 'Custom prompt'])

      fireEvent.click(screen.getByRole('menuitem', { name: 'Synonyms' }))
      const session = view.state.field(writingSessionField)!
      expect(session).to.include({ from: 9, to: 14, action: 'synonyms' })
      expect(view.state.selection.main.empty).to.equal(true)
    })

    it('shows directly the previous generation when clicking Writing tools button on previously generated text', function () {
      const doc = 'We saw a quick result.'
      const from = 9
      const to = 14
      saveWritingToolHistory({
        kind: 'writing-tool',
        originalText: 'quick',
        action: 'synonyms',
        history: { versions: [], index: 0 },
        synonyms: ['rapid', 'fast'],
        durationMs: 100,
        timestamp: Date.now(),
      })

      const view = renderEditor(doc, { from, to }, <WritingToolsAction />)
      fireEvent.click(screen.getByRole('button', { name: /Writing tools/ }))
      const session = view.state.field(writingSessionField)
      expect(session).to.not.be.null
      expect(session?.action).to.equal('synonyms')
    })

    it('lists sentence tools for two sentences', function () {
      const doc = 'The first sentence is here. A second one follows it now.'
      renderEditor(doc, { from: 0, to: doc.length }, <WritingToolsAction />)
      fireEvent.click(screen.getByRole('button', { name: /Writing tools/ }))
      const items = screen
        .getAllByRole('menuitem')
        .map(i => i.querySelector('.ai-texgpt-menu-item-label')?.textContent)
      expect(items).to.deep.equal([
        'Rephrase',
        'Shorten',
        'More scientific',
        'Join short sentences',
        'Translate',
        'Custom prompt',
      ])
    })

    it('explains why a selection of math alone has no tools', function () {
      const doc = 'Let $x^2 + y^2 = 1$ hold.'
      const from = doc.indexOf('$')
      renderEditor(
        doc,
        { from, to: doc.lastIndexOf('$') + 1 },
        <WritingToolsAction />
      )
      fireEvent.click(screen.getByRole('button', { name: /Writing tools/ }))
      expect(screen.getByText(/no text to rewrite/)).to.exist
      expect(screen.getAllByRole('menuitem')).to.have.length(1)
    })
  })

  describe('result card', function () {
    const doc = 'Intro. The results is good. End.'
    const from = doc.indexOf('The results')
    const to = from + 'The results is good.'.length

    it('streams a rewrite, shows the diff and replaces only changed words', async function () {
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<rewrite>The results are good.</rewrite>' })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)

      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      // The button exists, disabled, while the reply streams
      await waitFor(() => expect(replace.disabled).to.equal(false))
      expect(document.querySelector('.ai-writing-tools-text del')?.textContent).to.equal('is')
      expect(document.querySelector('.ai-writing-tools-text ins')?.textContent).to.equal('are')

      const body = JSON.parse(
        String(fetchMock.callHistory.calls(CHAT)[0].options.body)
      )
      expect(body.providerSettings.thinking).to.equal(false)
      expect(body.request.messages[0].content).to.include(
        '<selection>\nThe results is good.\n</selection>'
      )

      fireEvent.click(replace)
      expect(view.state.doc.toString()).to.equal('Intro. The results are good. End.')
      expect(view.state.field(writingSessionField)).to.equal(null)
    })

    it('keeps the author text for a clicked change', async function () {
      fetchMock.post(
        CHAT,
        ndjson({
          type: 'text',
          text: '<rewrite>The results are good. End.</rewrite>',
        })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)

      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      await waitFor(() => expect(replace.disabled).to.equal(false))
      const change = screen.getByRole('button', { name: /Change "is" to "are"/ })
      expect(change.getAttribute('aria-pressed')).to.equal('true')

      fireEvent.click(change)
      expect(change.getAttribute('aria-pressed')).to.equal('false')
      expect(change.querySelector('.ai-language-suggestion-kept')?.textContent).to.equal('is')

      fireEvent.click(replace)
      expect(view.state.doc.toString()).to.equal('Intro. The results is good. End. End.')
    })

    it('offers Copy but not Replace to read-only users', async function () {
      fetchMock.post(CHAT, ndjson({ type: 'text', text: '<rewrite>Better.</rewrite>' }))
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />, {
        ...WRITE,
        write: false,
      })
      openSession(view, from, to)
      await screen.findByRole('button', { name: /Copy/ })
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: /Copy/ }) as HTMLButtonElement).disabled
        ).to.equal(false)
      )
      expect(screen.queryByRole('button', { name: /Replace/ })).to.equal(null)
    })

    it('blocks Replace when the text changed underneath', async function () {
      fetchMock.post(CHAT, ndjson({ type: 'text', text: '<rewrite>Better.</rewrite>' }))
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      await waitFor(() => expect(replace.disabled).to.equal(false))

      view.dispatch({ changes: { from: from + 4, to: from + 11, insert: 'outcome' } })
      await screen.findByText(/The text changed/)
      expect(replace.disabled).to.equal(true)
    })

    it('says so, without Replace, when nothing needs changing', async function () {
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<rewrite>The results is good.</rewrite>' })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      await screen.findByText(/No changes suggested/)
      expect(
        (screen.getByRole('button', { name: /Replace/ }) as HTMLButtonElement)
          .disabled
      ).to.equal(true)
    })

    it('shows the reason when the model cannot apply the action', async function () {
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<cannot>There is no prose to rephrase.</cannot>' })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      await screen.findByText('There is no prose to rephrase.')
    })

    it('asks for a provider, then for consent, before sending anything', async function () {
      customLocalStorage.removeItem('ai-assist:provider')
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      await screen.findByText('Set up an AI provider')
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    })

    it('asks for consent first when it was never given', async function () {
      customLocalStorage.removeItem('ai-assist:consent')
      fetchMock.post(CHAT, ndjson({ type: 'text', text: '<rewrite>Better.</rewrite>' }))
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      fireEvent.click(await screen.findByRole('button', { name: 'Allow and continue' }))
      await screen.findByRole('button', { name: /Replace/ })
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)
    })

    it('replaces the selection with a chosen synonym', async function () {
      const synonymsDoc = 'We saw a quick result.'
      fetchMock.post(
        CHAT,
        ndjson({
          type: 'text',
          text: '<synonyms><s>rapid</s><s>swift</s></synonyms>',
        })
      )
      const view = renderEditor(synonymsDoc, { from: 9, to: 14 }, <WritingToolsCard />)
      openSession(view, 9, 14, 'synonyms')
      fireEvent.click(await screen.findByRole('button', { name: 'swift' }))
      expect(view.state.doc.toString()).to.equal('We saw a swift result.')
    })

    it('does not send a request on clicking settings chips until Retry is clicked', async function () {
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<rewrite>First attempt.</rewrite>' })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      await waitFor(() => expect(replace.disabled).to.equal(false))
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)

      // Open settings
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      const highChip = await screen.findByRole('button', { name: 'high' })

      // Click "high" chip — should NOT send request
      fireEvent.click(highChip)
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)

      // Click "scientific" chip — should NOT send request
      const scientificChip = screen.getByRole('button', { name: 'scientific' })
      fireEvent.click(scientificChip)
      expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1)

      // Setup next response for Retry
      fetchMock.removeRoutes().clearHistory()
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<rewrite>Second attempt with high scientific.</rewrite>' })
      )
      fetchMock.put('/ai-assist/preferences', { preferences: null })

      // Click Retry — NOW it sends the request with the new settings
      const retryBtn = screen.getByRole('button', { name: /Retry/ })
      fireEvent.click(retryBtn)
      await waitFor(() => expect(fetchMock.callHistory.calls(CHAT)).to.have.length(1))

      const retryBody = JSON.parse(
        String(fetchMock.callHistory.calls(CHAT)[0].options.body)
      )
      const content = retryBody.request.messages[0].content
      expect(content).to.include('Thorough: rewrite with clearly different wording')
      expect(content).to.include('Tone: formal, precise and objective')
    })

    it('plays zoom-out animation and unmounts settings card when toggling off', async function () {
      fetchMock.post(
        CHAT,
        ndjson({ type: 'text', text: '<rewrite>First attempt.</rewrite>' })
      )
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      await waitFor(() => expect(replace.disabled).to.equal(false))

      // Click settings to open
      const settingsBtn = screen.getByRole('button', { name: 'Settings' })
      fireEvent.click(settingsBtn)
      const highChip = await screen.findByRole('button', { name: 'high' })
      expect(highChip.closest('.ai-writing-tools-settings-card')).to.exist

      // Click settings again to close -> triggers zoom-out closing animation
      fireEvent.click(settingsBtn)
      const closingCard = document.querySelector('.ai-writing-tools-settings-card-closing')
      expect(closingCard).to.exist

      // Trigger animation end -> card unmounts
      fireEvent.animationEnd(closingCard!)
      expect(document.querySelector('.ai-writing-tools-settings-card')).to.be.null
    })

    it('closes on Escape', async function () {
      fetchMock.post(CHAT, ndjson({ type: 'text', text: '<rewrite>Better.</rewrite>' }))
      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      const card = await screen.findByRole('dialog')
      fireEvent.keyDown(card, { key: 'Escape' })
      expect(view.state.field(writingSessionField)).to.equal(null)
    })

    it('restores previous generation from cache on mount without making chat request', async function () {
      const text = doc.slice(from, to)
      saveWritingToolHistory({
        kind: 'writing-tool',
        originalText: text,
        action: 'rephrase',
        history: {
          versions: [
            { text: 'Cached rephrased version.', warnings: [], unit: 'phrase' },
          ],
          index: 0,
        },
        synonyms: [],
        durationMs: 250,
        timestamp: Date.now(),
      })

      const view = renderEditor(doc, { from, to }, <WritingToolsCard />)
      openSession(view, from, to)
      const replace = (await screen.findByRole('button', {
        name: /Replace/,
      })) as HTMLButtonElement
      await waitFor(() => expect(replace.disabled).to.equal(false))
      // The diff splits words into their own elements, so read the shown result
      // without the struck-out original words.
      const shown = document.querySelector('.ai-writing-tools-text')?.cloneNode(true) as HTMLElement
      shown.querySelectorAll('del').forEach(el => el.remove())
      expect(shown.textContent?.replace(/\s+/g, ' ').trim()).to.equal(
        'Cached rephrased version.'
      )
      expect(fetchMock.callHistory.calls(CHAT)).to.have.lengthOf(0)
    })
  })
})
