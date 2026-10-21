import { expect } from 'chai'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import { ChatHistoryMenu } from '../../../../../frontend/js/features/ai-assist/components/agent/chat-history-menu'
import { resetDocumentFocus } from '../../helpers/document-focus'

const PROJECT = 'project-1'

describe('ChatHistoryMenu rename', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get(`/ai-assist/projects/${PROJECT}/chats`, {
      chats: [
        {
          id: 'chat_a',
          title: 'Original title',
          createdAt: 1,
          updatedAt: Date.now(),
          messageCount: 1,
        },
      ],
    })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    resetDocumentFocus()
  })

  async function rename(
    onRename: (id: string, title: string) => Promise<void>
  ) {
    render(
      <ChatHistoryMenu
        projectId={PROJECT}
        activeChatId="other"
        onOpen={() => {}}
        onDelete={async () => {}}
        onRename={onRename}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    await screen.findByText('Original title')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('Original title')
    fireEvent.change(input, { target: { value: 'New title' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  }

  it('keeps the new title when the server saves it', async function () {
    const calls: string[] = []
    await rename(async (_id, title) => {
      calls.push(title)
    })
    expect(calls).to.deep.equal(['New title'])
    await screen.findByText('New title')
    expect(screen.queryByText('Original title')).to.be.null
  })

  it('puts the old title back when the rename fails', async function () {
    await rename(() => Promise.reject(new Error('save failed')))
    await waitFor(() => {
      expect(screen.getByText('Original title')).to.exist
      expect(screen.queryByText('New title')).to.be.null
    })
  })
})

describe('ChatHistoryMenu floating', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    fetchMock.get(`/ai-assist/projects/${PROJECT}/chats`, {
      chats: [
        {
          id: 'chat_a',
          title: 'Original title',
          createdAt: 1,
          updatedAt: Date.now(),
          messageCount: 1,
        },
      ],
    })
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    resetDocumentFocus()
  })

  async function openMenu() {
    render(
      <ChatHistoryMenu
        projectId={PROJECT}
        activeChatId="other"
        onOpen={() => {}}
        onDelete={async () => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    await screen.findByText('Original title')
    return screen.getByRole('menu') as HTMLElement
  }

  it('floats with the panel-tracking engine, like the other popovers', async function () {
    const menu = await openMenu()
    // floating-ui with autoUpdate: fixed positioning, repositioned by the
    // engine as the anchor (and the panel around it) resizes
    expect(menu.style.position).to.equal('fixed')
    expect(menu.style.transform).to.not.equal('')
  })

  it('closes on a mousedown outside the box and the toggle', async function () {
    await openMenu()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Original title')).to.be.null
  })

  it('stays open while the mousedown starts on the toggle', async function () {
    await openMenu()
    fireEvent.mouseDown(
      screen.getByRole('button', { name: 'Chat history' })
    )
    expect(screen.getByText('Original title')).to.exist
  })
})
