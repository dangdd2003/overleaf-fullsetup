import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import customLocalStorage from '@/infrastructure/local-storage'
import { AgentPanel } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-panel'
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

  it('lists saved chats and opens the picked one', async function () {
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

    render(
      <EditorProviders mockCompileOnLoad>
        <AgentPanel />
      </EditorProviders>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    fireEvent.click(await screen.findByText('Fix the bibliography'))

    await waitFor(() =>
      expect(customLocalStorage.getItem(`ai-assist:chat-id:${PROJECT_ID}`)).to.equal(
        'chat_old'
      )
    )
    expect(screen.getAllByText('Fix the bibliography').length).to.be.greaterThan(0)
  })
})
