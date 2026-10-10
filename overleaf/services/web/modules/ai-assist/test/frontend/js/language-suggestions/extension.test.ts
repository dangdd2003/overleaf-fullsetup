import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { waitFor } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import customLocalStorage from '@/infrastructure/local-storage'
import {
  extension,
  languageSuggestionsExtension,
} from '../../../../frontend/js/features/ai-assist/language-suggestions/extension'
import { suggestionCache } from '../../../../frontend/js/features/ai-assist/language-suggestions/cache'
import { forgetLanguageSuggestionsPreferences } from '../../../../frontend/js/features/ai-assist/language-suggestions/preferences'

const CHAT = '/ai-assist/providers/editor'

const FAST = {
  type: 'ollama',
  baseUrl: 'http://ollama:11434/v1',
  apiKey: '',
  model: 'qwen3:4b',
}

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

function ndjson(...chunks: object[]) {
  return {
    body: [...chunks, { type: 'done' }].map(c => JSON.stringify(c) + '\n').join(''),
    headers: { 'Content-Type': 'application/x-ndjson' },
  }
}

describe('language suggestions: editor extension', function () {
  beforeEach(function () {
    setMeta()
    document.body.innerHTML = ''
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    suggestionCache.clear()
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get('/ai-assist/preferences', { preferences: null })
    fetchMock.put('/ai-assist/preferences', { preferences: null })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
    forgetLanguageSuggestionsPreferences()
    suggestionCache.clear()
  })

  it('adds nothing to the editor with AI off', function () {
    setMeta({ enabled: false })
    expect(extension()).to.deep.equal([])
  })

  it('underlines what the fast model suggests, end to end', async function () {
    customLocalStorage.setItem('ai-assist:provider', { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude' })
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    customLocalStorage.setItem('ai-assist:consent', true)
    customLocalStorage.setItem('ai-assist:language-suggestions', { enabled: true })
    fetchMock.post(CHAT, ndjson({ type: 'text', text: '<s id="s1">The results show a gain.</s>' }))

    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'The results shows a gain.',
        extensions: languageSuggestionsExtension(),
      }),
      parent,
    })
    try {
      await waitFor(() => {
        expect(view.contentDOM.querySelector('.ol-language-suggestion')?.textContent).to.equal('shows')
      })
      const [call] = fetchMock.callHistory.calls(CHAT)
      const body = JSON.parse(call.options.body as string)
      expect(body.providerSettings).to.include({ type: 'ollama', baseUrl: 'http://ollama:11434/v1' })
    } finally {
      view.destroy()
    }
  })

  it('sends nothing until the user turns suggestions on', async function () {
    customLocalStorage.setItem('ai-assist:provider', { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude' })
    customLocalStorage.setItem('ai-assist:fast-provider', FAST)
    customLocalStorage.setItem('ai-assist:consent', true)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'The results shows a gain.',
        extensions: languageSuggestionsExtension(),
      }),
      parent,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fetchMock.callHistory.calls(CHAT)).to.have.length(0)
    view.destroy()
  })
})
