import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
import {
  getStoredChatMode,
  setStoredChatMode,
} from '../../../../../frontend/js/features/ai-assist/agent/chat-history-client'
import {
  EditorProviders,
  PROJECT_ID,
} from '../../../../../../../test/frontend/helpers/editor-providers'

describe('AgentPanel chat history', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    customLocalStorage.clear()
  })

  it('lists saved chats and opens the picked one with title in header', async function () {
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats`, {
      chats: [
        {
          id: 'chat_old',
          title: 'Fix the bibliography',
          createdAt: 1,
          updatedAt: Date.now(),
          messageCount: 1,
        },
      ],
    })
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/chat_old`, {
      id: 'chat_old',
      title: 'Fix the bibliography',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      transcript: [{ id: 'u0', role: 'user', text: 'Fix the bibliography' }],
    })
    fetchMock.patch(`/ai-assist/projects/${PROJECT_ID}/chats/chat_old`, {
      id: 'chat_old',
      title: 'Updated Title',
    })

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    fireEvent.click(await screen.findByText('Fix the bibliography'))

    await waitFor(() =>
      expect(
        customLocalStorage.getItem(`ai-assist:chat-id:${PROJECT_ID}`)
      ).to.equal('chat_old')
    )

    // Verify title displayed in header
    expect(
      screen.getAllByText('Fix the bibliography').length
    ).to.be.greaterThan(0)

    // Rename chat via header rename button
    const renameBtn = document.querySelector('.ai-assist-header-rename-btn')!
    expect(renameBtn).to.exist
    fireEvent.click(renameBtn)

    const input = screen.getByDisplayValue('Fix the bibliography')
    fireEvent.change(input, { target: { value: 'Updated Title' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      const calls = fetchMock.callHistory.calls(
        `/ai-assist/projects/${PROJECT_ID}/chats/chat_old`
      )
      expect(calls.length).to.be.at.least(1)
      const lastCall = calls[calls.length - 1]
      expect(lastCall.options.method?.toUpperCase()).to.equal('PATCH')
      expect(JSON.parse(lastCall.options.body as string)).to.deep.equal({
        title: 'Updated Title',
      })
    })
  })

  it('restores chosen mode persistently on open chat panel rather than defaulting to manual', async function () {
    customLocalStorage.setItem(`ai-assist:chat-id:${PROJECT_ID}`, 'chat_custom')
    setStoredChatMode(PROJECT_ID, 'chat_custom', 'acceptEdits')
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/chat_custom`, {
      id: 'chat_custom',
      title: 'Auto edit session',
      mode: 'acceptEdits',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      transcript: [],
    })

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    // The composer mode label should render Accept edits immediately
    expect(screen.getByText('Accept edits')).to.exist
  })

  it('persists mode change per chat session and switches mode when opening another chat', async function () {
    customLocalStorage.setItem('ai-assist:provider', {
      type: 'openai',
      apiKey: 'k',
      model: 'gpt-4o',
    })
    customLocalStorage.setItem(`ai-assist:chat-id:${PROJECT_ID}`, 'chat_1')
    setStoredChatMode(PROJECT_ID, 'chat_1', 'manual')

    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/chat_1`, {
      id: 'chat_1',
      title: 'Chat 1',
      mode: 'manual',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      transcript: [{ id: 'u0', role: 'user', text: 'hello' }],
    })
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats/chat_2`, {
      id: 'chat_2',
      title: 'Chat 2',
      mode: 'plan',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      transcript: [{ id: 'u1', role: 'user', text: 'plan something' }],
    })
    fetchMock.get(`/ai-assist/projects/${PROJECT_ID}/chats`, {
      chats: [
        {
          id: 'chat_1',
          title: 'Chat 1',
          mode: 'manual',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
        },
        {
          id: 'chat_2',
          title: 'Chat 2',
          mode: 'plan',
          createdAt: 1,
          updatedAt: 3,
          messageCount: 1,
        },
      ],
    })
    fetchMock.put(`/ai-assist/projects/${PROJECT_ID}/chats/chat_1`, {
      id: 'chat_1',
      title: 'Chat 1',
      mode: 'acceptEdits',
      createdAt: 1,
      updatedAt: 4,
      messageCount: 1,
    })

    const { container } = render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    // Chat 1 starts in manual mode
    expect(
      container.querySelector('.ai-assist-mode-label')?.textContent
    ).to.equal('Manual')

    // Change mode in Chat 1 to Accept edits
    const modeToggle = container.querySelector('#ai-assist-mode-toggle')!
    fireEvent.click(modeToggle)
    const acceptEditsItem = screen.getByText('Accept edits', {
      selector: '.ai-assist-mode-item-title',
    })
    fireEvent.click(acceptEditsItem)

    // Chat 1 mode changed to acceptEdits and stored
    expect(
      container.querySelector('.ai-assist-mode-label')?.textContent
    ).to.equal('Accept edits')
    expect(getStoredChatMode(PROJECT_ID, 'chat_1')).to.equal('acceptEdits')

    // Open chat history and switch to Chat 2
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    fireEvent.click(await screen.findByText('Chat 2'))

    // Chat 2 should be in Plan mode
    await waitFor(() => {
      expect(
        container.querySelector('.ai-assist-mode-label')?.textContent
      ).to.equal('Plan')
      expect(getStoredChatMode(PROJECT_ID, 'chat_2')).to.equal('plan')
    })

    // Click New chat -> defaults to manual mode
    fireEvent.click(screen.getByLabelText('New chat'))
    await waitFor(() => {
      expect(
        container.querySelector('.ai-assist-mode-label')?.textContent
      ).to.equal('Manual')
    })
  })
})
