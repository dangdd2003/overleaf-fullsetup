import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import BatchRestoreUsersModal from '../../frontend/js/components/batch-restore-users-modal'
import RestoreUserModal from '../../frontend/js/components/restore-user-modal'

const endpoint = '/admin/users/api/users/batch-restore'

describe('admin account recovery', function () {
  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
  })

  it('retries only incomplete accounts after a mixed batch result', async function () {
    const onSuccess = sinon.stub()
    const onHide = sinon.stub()
    let calls = 0
    const bodies: unknown[] = []
    fetchMock.post(endpoint, ({ options }) => {
      bodies.push(JSON.parse(options.body as string))
      calls++
      return calls === 1
        ? {
            success: true,
            restoredCount: 1,
            restoredProjectsCount: 3,
            failed: [{ userId: 'second', reason: 'projects_pending_restore' }],
          }
        : {
            success: true,
            restoredCount: 1,
            restoredProjectsCount: 2,
            failed: [],
          }
    })
    render(
      <BatchRestoreUsersModal
        show
        records={[
          {
            _id: 'archive-first',
            user: { _id: 'first', email: 'first@example.com' },
          },
          {
            _id: 'archive-second',
            user: { _id: 'second', email: 'second@example.com' },
          },
        ]}
        onHide={onHide}
        onSuccess={onSuccess}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore 2 Accounts' }))
    await screen.findByText(/Some accounts or projects still need recovery/)
    sinon.assert.notCalled(onSuccess)
    sinon.assert.notCalled(onHide)
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Restore 2 Accounts',
          }) as HTMLButtonElement
        ).disabled
      ).to.equal(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore 2 Accounts' }))
    await waitFor(() => sinon.assert.calledOnce(onSuccess))
    expect(bodies).to.deep.equal([
      { userIds: ['first', 'second'] },
      { userIds: ['second'] },
    ])
    sinon.assert.calledWith(onSuccess, 2, 5)
    sinon.assert.calledOnce(onHide)
  })

  it('keeps partial single-account recovery visible for retry', async function () {
    const onSuccess = sinon.stub()
    const onHide = sinon.stub()
    fetchMock.post('/admin/users/api/users/account/restore', {
      success: true,
      restoredProjectCount: 1,
      failedProjectIds: ['failed-project'],
    })
    render(
      <RestoreUserModal
        show
        user={{ _id: 'account', email: 'user@example.com' }}
        onHide={onHide}
        onSuccess={onSuccess}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore Account' }))
    await screen.findByText(/failed-project/)
    sinon.assert.notCalled(onSuccess)
    sinon.assert.notCalled(onHide)
  })
})
