import { expect } from 'chai'
import sinon from 'sinon'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RewindDialog, RewindChoice } from '../../../../../frontend/js/features/ai-assist/components/agent/rewind-dialog'
import * as rewindClient from '../../../../../frontend/js/features/ai-assist/agent/rewind-client'
import fetchMock from 'fetch-mock'

describe('RewindDialog Component', function () {
  let checkRewindStub: sinon.SinonStub

  beforeEach(function () {
    checkRewindStub = sinon.stub(rewindClient, 'checkRewind')
  })

  afterEach(function () {
    checkRewindStub.restore()
  })

  it('renders nothing when isOpen is false', function () {
    const { container } = render(
      <RewindDialog
        isOpen={false}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )
    expect(container.firstChild).to.be.null
  })

  it('renders loading state and triggers checkRewind on open', async function () {
    checkRewindStub.returns(new Promise(() => {})) // never resolves immediately

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    expect(checkRewindStub.calledOnceWith('project-123', 'chat-123', 'u0')).to.be.true
    expect(screen.getByText('Checking code changes...')).to.exist
  })

  it('displays code changes summary when check succeeds with changes', async function () {
    checkRewindStub.resolves({
      canRewind: true,
      filesChanged: ['main.tex', 'references.bib'],
      insertions: 5,
      deletions: 12,
    })

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    expect(screen.getByText(/12 lines/)).to.exist
    expect(screen.getByText(/5 lines/)).to.exist
    expect(screen.getByText('main.tex')).to.exist
    expect(screen.getByText('references.bib')).to.exist
  })

  it('displays no changes notice when check returns no changed files', async function () {
    checkRewindStub.resolves({
      canRewind: false,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    expect(
      screen.getByText('The code has not changed, so no code will be restored.')
    ).to.exist
  })

  it('displays error message when check fails', async function () {
    checkRewindStub.rejects(new Error('Checkpoint data corrupted'))

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    expect(screen.getByText('Checkpoint data corrupted')).to.exist
  })

  it('allows selecting different restore options and confirms with choice', async function () {
    checkRewindStub.resolves({
      canRewind: true,
      filesChanged: ['main.tex'],
      insertions: 2,
      deletions: 3,
    })

    const onConfirm = sinon.stub().resolves()
    const onClose = sinon.stub()

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        initialChoice="both"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    const conversationBtn = screen.getByText('Restore conversation').closest('button')!
    fireEvent.click(conversationBtn)
    expect(conversationBtn.getAttribute('aria-pressed')).to.equal('true')

    const confirmBtn = screen.getByRole('button', { name: 'Rewind' })
    fireEvent.click(confirmBtn)

    expect(onConfirm.calledOnceWith('conversation')).to.be.true
  })

  it('calls onClose when Never mind button is clicked', async function () {
    checkRewindStub.resolves({
      canRewind: false,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })

    const onClose = sinon.stub()
    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        onClose={onClose}
        onConfirm={sinon.stub().resolves()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    const cancelBtn = screen.getByText('Never mind')
    fireEvent.click(cancelBtn)
    expect(onClose.calledOnce).to.be.true
  })

  it('renders fork note and Continue label when willFork is true', async function () {
    checkRewindStub.resolves({
      canRewind: true,
      filesChanged: ['main.tex'],
      insertions: 1,
      deletions: 1,
    })

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        willFork={true}
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    expect(screen.getByText('Fork and rewind')).to.exist
    expect(
      screen.getByText('A new forked conversation will be created after rewinding.')
    ).to.exist
    expect(screen.getByText('Continue')).to.exist
  })

  it('forwards userMessageIds to the check', async function () {
    checkRewindStub.resolves({ canRewind: false, filesChanged: [] })

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        userMessageIds={['u0', 'u1']}
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    expect(
      checkRewindStub.calledOnceWith('project-123', 'chat-123', 'u0', ['u0', 'u1'])
    ).to.be.true
  })

  it('keeps the dialog open and shows the reason when confirming fails', async function () {
    checkRewindStub.resolves({
      canRewind: true,
      filesChanged: ['main.tex'],
      insertions: 1,
      deletions: 1,
    })

    const onConfirm = sinon
      .stub()
      .rejects(new Error('Could not restore: main.tex'))
    const onClose = sinon.stub()

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        initialChoice="code"
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).to.contain(
        'Could not restore: main.tex'
      )
    })
    expect(onConfirm.calledOnceWith('code')).to.be.true
    expect(onClose.called).to.be.false
    expect(screen.getByText('Restore conversation')).to.exist
    expect(
      (screen.getByRole('button', { name: 'Rewind' }) as HTMLButtonElement)
        .disabled
    ).to.be.false

    // Changing the choice clears the reason
    fireEvent.click(screen.getByText('Restore conversation').closest('button')!)
    expect(screen.queryByRole('alert')).to.not.exist
  })

  it('disables confirm for code-only rewind when no code changed', async function () {
    checkRewindStub.resolves({
      canRewind: false,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })

    render(
      <RewindDialog
        isOpen={true}
        projectId="project-123"
        chatId="chat-123"
        userMessageId="u0"
        initialChoice="code"
        onClose={sinon.stub()}
        onConfirm={sinon.stub().resolves()}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText('Checking code changes...')).to.not.exist
    })

    const confirmBtn = () =>
      screen.getByRole('button', { name: 'Rewind' }) as HTMLButtonElement
    expect(confirmBtn().disabled).to.be.true

    fireEvent.click(screen.getByText('Restore code and conversation').closest('button')!)
    expect(confirmBtn().disabled).to.be.false
  })
})

describe('checkRewind request', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('sends userMessageIds in the body', async function () {
    fetchMock.post('/ai-assist/projects/project-123/chats/chat-123/rewind/check', {
      canRewind: false,
      filesChanged: [],
    })

    await rewindClient.checkRewind('project-123', 'chat-123', 'u1', ['u1', 'u2'])

    const calls = fetchMock.callHistory.calls()
    const body = JSON.parse(String(calls[calls.length - 1]?.options?.body ?? '{}'))
    expect(body).to.deep.equal({ userMessageId: 'u1', userMessageIds: ['u1', 'u2'] })
  })
})
