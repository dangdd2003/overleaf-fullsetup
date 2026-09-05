import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import GoogleDriveModal from '@/features/ide-react/components/modals/google-drive-modal'
import { ProjectContext } from '@/shared/context/project-context'
import { RailProvider } from '@/features/ide-react/context/rail-context'

function getFetchCalls(url: string): any[] {
  if (
    fetchMock.callHistory &&
    typeof fetchMock.callHistory.calls === 'function'
  ) {
    return fetchMock.callHistory.calls(url)
  }
  return (fetchMock as any).calls?.(url) || []
}

describe('<GoogleDriveModal />', function () {
  const projectId = '60f1b4a9e1b2c3d4e5f6g7h8'
  const mockProjectContextValue: any = {
    projectId,
    project: {
      _id: projectId,
      name: 'Sample Project',
      features: {},
    },
    joinProject: sinon.stub(),
    updateProject: sinon.stub(),
    joinedOnce: true,
    projectSnapshot: {} as any,
    tags: [],
    features: {},
    name: 'Sample Project',
  }

  // Fake timers (sinon@7's lolex-based clock) also stub setImmediate, so a
  // macrotask-based flush would hang forever under fake time. Plain
  // microtask hops aren't affected by fake timers, so drain those instead.
  async function flushPromises() {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  }

  function renderModal(props = { show: true, onHide: sinon.stub() }) {
    return render(
      <ProjectContext.Provider value={mockProjectContextValue}>
        <RailProvider>
          <GoogleDriveModal {...props} />
        </RailProvider>
      </ProjectContext.Provider>
    )
  }

  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    sinon.restore()
  })

  it('renders modal dialog with data-testid="google-drive-modal" and title "Google Drive"', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId: 'folder_123',
    })

    renderModal()

    await waitFor(() => {
      const modal = screen.getByTestId('google-drive-modal')
      expect(modal).to.exist
      expect(screen.getByText('Google Drive')).to.exist
    })
  })

  it('displays "Up to date" status with checkmark when idle or up_to_date', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      lastSyncedAt: '2026-08-30T10:00:00.000Z',
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-up-to-date-status')).to.exist
      expect(screen.getByText('Up to date')).to.exist
    })
  })

  it('displays an info notice, not "Up to date", when the project is linked but has never been synced', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      lastSyncedAt: null,
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-never-synced-status')).to.exist
      expect(
        screen.getByText(
          "This project hasn't been synced with Google Drive yet."
        )
      ).to.exist
      expect(screen.queryByTestId('google-drive-up-to-date-status')).to.be.null
    })
  })

  it('displays "Syncing..." status when project is actively syncing', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'syncing',
      isSyncing: true,
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-syncing-status')).to.exist
      expect(screen.getByText('Syncing...')).to.exist
    })
  })

  it('displays error alert when syncStatus is error or lastError is present', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'error',
      lastError: 'Google Drive quota exceeded',
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-error-alert')).to.exist
      expect(screen.getByText('Google Drive quota exceeded')).to.exist
    })
  })

  it('displays unlinked notice with link to settings when project is unlinked', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: false,
      syncStatus: 'unlinked',
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-unlinked-status')).to.exist
      expect(
        screen.getByText(
          'Not linked to Google Drive. Link your account in Account Settings.'
        )
      ).to.exist
      const settingsLink = screen.getByRole('link', {
        name: /Go to account settings/i,
      })
      expect(settingsLink).to.exist
      expect(settingsLink.getAttribute('href')).to.equal(
        '/user/settings#project-sync'
      )
    })
  })

  it('displays "Open folder in Google Drive ↗" link when driveFolderId is present', async function () {
    const driveFolderId = 'drive_folder_abc123'
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId,
    })

    renderModal()

    await waitFor(() => {
      const folderLink = screen.getByTestId('google-drive-folder-link')
      expect(folderLink).to.exist
      expect(folderLink.getAttribute('href')).to.equal(
        `https://drive.google.com/drive/folders/${driveFolderId}`
      )
      expect(folderLink.getAttribute('target')).to.equal('_blank')
    })
  })

  it('displays conflict alert when conflicts are present in status', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      conflicts: ['main.tex'],
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-conflict-alert')).to.exist
      expect(
        screen.getByText(
          'Overleaf preserved your live edits and created timestamped conflict copies for conflicting Google Drive files.'
        )
      ).to.exist
      expect(screen.getByTestId('dismiss-conflicts-button')).to.exist
    })
  })

  it('displays conflict list and "Dismiss conflicts" button when conflicts are present', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      conflicts: [
        {
          path: 'main.tex',
          conflictPath: 'main (conflict 2026-09-03).tex',
          detectedAt: '2026-09-03T10:00:00.000Z',
        },
      ],
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-conflict-alert')).to.exist
      expect(screen.getByTestId('dismiss-conflicts-button')).to.exist
      expect(screen.getByText('main.tex → main (conflict 2026-09-03).tex')).to
        .exist
    })
  })

  it('triggers POST /project/:projectId/google-drive/conflicts/dismiss when "Dismiss conflicts" is clicked', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      conflicts: [
        {
          path: 'main.tex',
          conflictPath: 'main (conflict 2026-09-03).tex',
          detectedAt: '2026-09-03T10:00:00.000Z',
        },
      ],
    })
    fetchMock.post(`/project/${projectId}/google-drive/conflicts/dismiss`, {
      success: true,
      linked: true,
      syncStatus: 'idle',
      conflicts: [],
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('dismiss-conflicts-button')).to.exist
    })

    fireEvent.click(screen.getByTestId('dismiss-conflicts-button'))

    await waitFor(() => {
      const postCalls = getFetchCalls(
        `/project/${projectId}/google-drive/conflicts/dismiss`
      )
      expect(postCalls.length).to.equal(1)
      expect(screen.queryByTestId('google-drive-conflict-alert')).to.be.null
    })
  })

  it('displays suspended alert with suspend reason and disables sync button when syncSuspended is true', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'error',
      syncSuspended: true,
      suspendReason: 'duplicate-project-name',
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('google-drive-suspended-alert')).to.exist
      expect(screen.getByText(/duplicate-project-name/)).to.exist
      const syncBtn = screen.getByTestId('sync-now-button') as HTMLButtonElement
      expect(syncBtn.disabled).to.be.true
    })
  })

  it('disables "Sync now" button when unlinked', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: false,
      syncStatus: 'unlinked',
    })

    renderModal()

    await waitFor(() => {
      const syncBtn = screen.getByTestId('sync-now-button')
      expect(syncBtn).to.exist
      expect((syncBtn as HTMLButtonElement).disabled).to.be.true
    })
  })

  it('triggers POST /project/:projectId/google-drive/sync on "Sync now" click', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId: 'folder_xyz',
    })
    fetchMock.post(`/project/${projectId}/google-drive/sync`, {
      success: true,
    })

    renderModal()

    await waitFor(() => {
      expect(screen.getByTestId('sync-now-button')).to.exist
    })

    const syncBtn = screen.getByTestId('sync-now-button')
    expect((syncBtn as HTMLButtonElement).disabled).to.be.false

    fireEvent.click(syncBtn)

    await waitFor(() => {
      const postCalls = getFetchCalls(`/project/${projectId}/google-drive/sync`)
      expect(postCalls.length).to.equal(1)
      const call = postCalls[0]
      const method = (
        call?.options?.method ||
        call?.args?.[1]?.method ||
        call?.[1]?.method ||
        ''
      ).toUpperCase()
      expect(method).to.equal('POST')
    })
  })

  it('disables the sync button and shows a countdown after a 429 rate-limited response', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId: 'folder_xyz',
    })
    fetchMock.post(`/project/${projectId}/google-drive/sync`, {
      status: 429,
      body: {
        code: 'rate_limited',
        message: 'Please wait before syncing this project again',
        retryAfterSeconds: 45,
      },
    })

    renderModal()

    await waitFor(() => {
      expect(
        (screen.getByTestId('sync-now-button') as HTMLButtonElement).disabled
      ).to.be.false
    })

    fireEvent.click(screen.getByTestId('sync-now-button'))

    await waitFor(() => {
      const syncBtn = screen.getByTestId('sync-now-button') as HTMLButtonElement
      expect(syncBtn.disabled).to.be.true
      expect(syncBtn.textContent).to.contain('45s')
    })
  })

  it('disables the sync button with a countdown on load when the project was manually synced recently', async function () {
    const clock = sinon.useFakeTimers(new Date('2026-09-02T12:00:00.000Z'))
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId: 'folder_xyz',
      lastManualSyncAt: '2026-09-02T11:59:35.000Z', // 25s ago -> 35s left
    })

    renderModal()
    await act(async () => {
      await flushPromises()
    })

    const syncBtn = screen.getByTestId('sync-now-button') as HTMLButtonElement
    expect(syncBtn.disabled).to.be.true
    expect(syncBtn.textContent).to.contain('35s')

    clock.restore()
  })

  it('re-enables the sync button once the cooldown reaches zero', async function () {
    const clock = sinon.useFakeTimers(new Date('2026-09-02T12:00:00.000Z'))
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
      driveFolderId: 'folder_xyz',
      lastManualSyncAt: '2026-09-02T11:59:02.000Z', // 58s ago -> 2s left
    })

    renderModal()
    await act(async () => {
      await flushPromises()
    })

    expect(
      (screen.getByTestId('sync-now-button') as HTMLButtonElement).disabled
    ).to.be.true

    await act(async () => {
      clock.tick(2000)
      await flushPromises()
    })

    const syncBtn = screen.getByTestId('sync-now-button') as HTMLButtonElement
    expect(syncBtn.disabled).to.be.false

    clock.restore()
  })

  it('calls onHide when close button is clicked', async function () {
    fetchMock.get(`/project/${projectId}/google-drive/status`, {
      linked: true,
      syncStatus: 'idle',
    })

    const onHideStub = sinon.stub()
    renderModal({ show: true, onHide: onHideStub })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).to.exist
    })

    const closeBtn = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeBtn)

    expect(onHideStub).to.have.been.calledOnce
  })
})
