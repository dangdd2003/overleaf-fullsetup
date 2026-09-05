import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import { GoogleDriveLinkingWidget } from '@/features/settings/components/linking/google-drive-widget'
import GoogleDriveLogo from '@/shared/svgs/google-drive-logo'

function isFetchCalled(url: string): boolean {
  if (
    fetchMock.callHistory &&
    typeof fetchMock.callHistory.called === 'function'
  ) {
    return fetchMock.callHistory.called(url)
  }
  return Boolean((fetchMock as any).called?.(url))
}

function getFetchLastCall(url: string): any {
  if (
    fetchMock.callHistory &&
    typeof fetchMock.callHistory.lastCall === 'function'
  ) {
    const call = fetchMock.callHistory.lastCall(url)
    return call
  }
  const call = (fetchMock as any).lastCall?.(url)
  return call
}

describe('<GoogleDriveLogo />', function () {
  it('renders Google Drive logo svg with default size 24', function () {
    const { container } = render(<GoogleDriveLogo />)
    const svg = container.querySelector('svg')
    expect(svg).to.exist
    expect(svg?.getAttribute('width')).to.equal('24')
    expect(svg?.getAttribute('height')).to.equal('24')
    expect(svg?.getAttribute('viewBox')).to.equal('0 0 87.3 78')
  })

  it('renders Google Drive logo svg with custom size', function () {
    const { container } = render(<GoogleDriveLogo size={48} />)
    const svg = container.querySelector('svg')
    expect(svg).to.exist
    expect(svg?.getAttribute('width')).to.equal('48')
    expect(svg?.getAttribute('height')).to.equal('48')
  })
})

describe('<GoogleDriveLinkingWidget />', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.delete('ol-googleDrive')
    window.metaAttributesCache.set('ol-csrfToken', 'test-csrf-token')
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.delete('ol-googleDrive')
    window.metaAttributesCache.delete('ol-csrfToken')
    sinon.restore()
  })

  describe('Unlinked State', function () {
    it('renders unlinked state with description and link button that opens oauth popup', async function () {
      const openStub = sinon.stub(window, 'open').returns({
        focus: sinon.spy(),
        closed: false,
      } as any)

      render(<GoogleDriveLinkingWidget initialIsLinked={false} />)

      expect(screen.getByText('Google Drive')).to.exist
      expect(
        screen.getByText(
          /Keep your Overleaf projects in sync with your Google Drive account/
        )
      ).to.exist

      const linkButton = screen.getByRole('button', { name: /Link/ })
      expect(linkButton).to.exist
      fireEvent.click(linkButton)

      expect(openStub.calledOnce).to.be.true
      expect(openStub.firstCall.args[0]).to.equal(
        '/auth/google-drive/oauth?popup=true'
      )
      expect(openStub.firstCall.args[1]).to.equal('google_drive_oauth')
    })

    it('updates to linked state when receiving oauth success postMessage', async function () {
      fetchMock.get('/auth/google-drive/status', {
        isLinked: true,
        googleEmail: 'linked-via-popup@example.com',
      })

      render(<GoogleDriveLinkingWidget initialIsLinked={false} />)

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'google-drive:oauth-success' },
        })
      )

      await waitFor(() => {
        expect(screen.getByText('linked-via-popup@example.com')).to.exist
      })
    })

    it('displays error message when receiving oauth error postMessage', async function () {
      render(<GoogleDriveLinkingWidget initialIsLinked={false} />)

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: {
            type: 'google-drive:oauth-error',
            error: 'Google login was denied',
          },
        })
      )

      await waitFor(() => {
        expect(screen.getByText('Google login was denied')).to.exist
      })
    })
  })

  describe('Linked State', function () {
    it('renders linked state with account email and unlink button', async function () {
      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
          initialLinkedAt="2026-08-30T10:00:00.000Z"
        />
      )

      expect(screen.getByText('Google Drive')).to.exist
      expect(screen.getByText(/Linked to Google Drive as/)).to.exist
      expect(screen.getByText('researcher@gmail.com')).to.exist

      const unlinkButton = screen.getByRole('button', {
        name: /Unlink/,
      })
      expect(unlinkButton).to.exist
    })

    it('opens confirmation modal when clicking unlink button', async function () {
      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      const unlinkButton = screen.getByRole('button', {
        name: /Unlink/,
      })
      fireEvent.click(unlinkButton)

      await waitFor(() => {
        expect(screen.getByText('Unlink Google Drive Account')).to.exist
        expect(
          screen.getByText(
            /Any projects that you have synced with Google Drive will be disconnected/
          )
        ).to.exist
      })
    })

    it('cancels unlink and closes modal when cancel button is clicked', async function () {
      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Unlink/ }))

      await waitFor(() => {
        expect(screen.getByText('Unlink Google Drive Account')).to.exist
      })

      const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelBtn)

      await waitFor(() => {
        expect(
          screen.queryByText(
            /Any projects that you have synced with Google Drive/
          )
        ).to.not.exist
      })
    })

    it('performs unlink request on confirm, updates UI to unlinked state, and calls onUnlinkSuccess', async function () {
      fetchMock.post('/auth/google-drive/unlink', {
        status: 200,
        body: { success: true },
      })
      const onUnlinkSuccess = sinon.spy()

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
          onUnlinkSuccess={onUnlinkSuccess}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Unlink/ }))

      await waitFor(() => {
        expect(screen.getByText('Unlink Google Drive Account')).to.exist
      })

      const modal = screen.getByRole('dialog')
      const confirmBtn = modal.querySelector('.btn-danger-ghost') as HTMLElement
      fireEvent.click(confirmBtn)

      await waitFor(() => {
        expect(isFetchCalled('/auth/google-drive/unlink')).to.be.true
        const call = getFetchLastCall('/auth/google-drive/unlink')
        const token =
          call?.args?.[1]?.headers?.['X-Csrf-Token'] ||
          call?.options?.headers?.['x-csrf-token'] ||
          call?.[1]?.headers?.['X-Csrf-Token']
        expect(token).to.equal('test-csrf-token')
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Link/ })).to.exist
        expect(screen.queryByText('researcher@gmail.com')).to.not.exist
        expect(onUnlinkSuccess.calledOnce).to.be.true
      })
    })

    it('renders a "Scan for existing projects" button', async function () {
      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      expect(screen.getByRole('button', { name: 'Scan for existing projects' }))
        .to.exist
    })

    it('shows the number of imported projects after a successful scan with new projects', async function () {
      fetchMock.post('/auth/google-drive/scan-existing-projects', {
        status: 200,
        body: {
          success: true,
          scannedCount: 3,
          createdCount: 2,
          createdProjects: [
            { projectId: 'p1', name: 'Paper A' },
            { projectId: 'p2', name: 'Paper B' },
          ],
        },
      })

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Scan for existing projects' })
      )

      await waitFor(() => {
        expect(screen.getByText(/Imported 2 project/)).to.exist
      })
    })

    it('shows synchronized message when scan synchronizes already-linked projects', async function () {
      fetchMock.post('/auth/google-drive/scan-existing-projects', {
        status: 200,
        body: {
          success: true,
          scannedCount: 2,
          createdCount: 0,
          createdProjects: [],
          syncedCount: 2,
          syncedProjects: [
            { projectId: 'p1', name: 'Paper A' },
            { projectId: 'p2', name: 'Paper B' },
          ],
        },
      })

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Scan for existing projects' })
      )

      await waitFor(() => {
        expect(screen.getByText(/Synchronized 2 existing project/)).to.exist
      })
    })

    it('shows all projects synced message when all scanned projects are already up to date', async function () {
      fetchMock.post('/auth/google-drive/scan-existing-projects', {
        status: 200,
        body: {
          success: true,
          scannedCount: 2,
          createdCount: 0,
          createdProjects: [],
          syncedCount: 0,
          syncedProjects: [],
        },
      })

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Scan for existing projects' })
      )

      await waitFor(() => {
        expect(
          screen.getByText(
            /Found 2 project\(s\) in Google Drive\. All are linked and up to date\./
          )
        ).to.exist
      })
    })

    it('shows a "no existing projects found" message when the scan finds 0 folders', async function () {
      fetchMock.post('/auth/google-drive/scan-existing-projects', {
        status: 200,
        body: {
          success: true,
          scannedCount: 0,
          createdCount: 0,
          createdProjects: [],
        },
      })

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Scan for existing projects' })
      )

      await waitFor(() => {
        expect(
          screen.getByText(
            'No existing projects found in your Google Drive folder.'
          )
        ).to.exist
      })
    })

    it('shows an error message when the scan request fails', async function () {
      fetchMock.post('/auth/google-drive/scan-existing-projects', {
        status: 500,
        body: { message: 'Drive API error' },
      })

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Scan for existing projects' })
      )

      await waitFor(() => {
        expect(screen.getByText('Drive API error')).to.exist
      })
    })

    it('handles unlink error and displays user-facing error message', async function () {
      fetchMock.post('/auth/google-drive/unlink', {
        status: 500,
        body: { message: 'Server failed to revoke token' },
      })
      const onUnlinkError = sinon.spy()

      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
          onUnlinkError={onUnlinkError}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Unlink/ }))

      await waitFor(() => {
        expect(screen.getByText('Unlink Google Drive Account')).to.exist
      })

      const modal = screen.getByRole('dialog')
      const confirmBtn = modal.querySelector('.btn-danger-ghost') as HTMLElement
      fireEvent.click(confirmBtn)

      await waitFor(() => {
        expect(screen.getByText('Server failed to revoke token')).to.exist
        expect(onUnlinkError.calledOnce).to.be.true
      })
    })
  })

  describe('Status Fetch on Mount', function () {
    it('fetches status from endpoint on mount when not supplied via props/meta', async function () {
      fetchMock.get('/auth/google-drive/status', {
        isLinked: true,
        googleEmail: 'auto-fetched@example.com',
        linkedAt: '2026-08-30T10:00:00.000Z',
      })

      render(<GoogleDriveLinkingWidget />)

      await waitFor(() => {
        expect(isFetchCalled('/auth/google-drive/status')).to.be.true
        expect(screen.getByText('auto-fetched@example.com')).to.exist
      })
    })
  })

  describe('Status Refresh on Tab Focus', function () {
    it('re-fetches status when the tab becomes visible again while unlinked, as a fallback', async function () {
      render(<GoogleDriveLinkingWidget initialIsLinked={false} />)

      fetchMock.get('/auth/google-drive/status', {
        isLinked: true,
        googleEmail: 'came-back@example.com',
      })

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => {
        expect(isFetchCalled('/auth/google-drive/status')).to.be.true
        expect(screen.getByText('came-back@example.com')).to.exist
      })
    })

    it('does not re-fetch status on tab focus once already linked', async function () {
      render(
        <GoogleDriveLinkingWidget
          initialIsLinked={true}
          initialGoogleEmail="researcher@gmail.com"
        />
      )

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))

      expect(isFetchCalled('/auth/google-drive/status')).to.be.false
    })
  })
})
