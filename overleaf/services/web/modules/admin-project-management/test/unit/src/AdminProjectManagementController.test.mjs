import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockProjectGetter,
  mockUserGetter,
  mockCollaboratorsGetter,
  mockOwnershipTransferHandler,
  mockSessionManager,
} = vi.hoisted(() => ({
  mockProjectGetter: { promises: { getProject: vi.fn() } },
  mockUserGetter: { promises: { getUser: vi.fn(), getUserByAnyEmail: vi.fn() } },
  mockCollaboratorsGetter: { promises: { getMemberIds: vi.fn() } },
  mockOwnershipTransferHandler: { promises: { transferOwnership: vi.fn() } },
  mockSessionManager: { getSessionUser: vi.fn() },
}))

vi.mock('@overleaf/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
  ObjectId: class MockObjectId {},
}))

vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: mockProjectGetter,
}))

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: mockUserGetter,
}))

vi.mock(
  '../../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs',
  () => ({ default: mockCollaboratorsGetter })
)

vi.mock(
  '../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs',
  () => ({ default: mockOwnershipTransferHandler })
)

vi.mock(
  '../../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({ default: mockSessionManager })
)

import AdminProjectManagementController from '../../../app/src/AdminProjectManagementController.mjs'

describe('AdminProjectManagementController', () => {
  const projectId = '507f1f77bcf86cd799439011'
  let req
  let res
  let next

  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionManager.getSessionUser.mockReturnValue({
      _id: '507f1f77bcf86cd799439099',
    })
    req = {
      params: { projectId },
      query: {},
      body: {},
      session: {},
      ip: '127.0.0.1',
    }
    res = {
      redirect: vi.fn(),
      render: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }
    next = vi.fn()
  })

  describe('renderProjectDetail', () => {
    it('forwards unexpected errors to next(err)', async () => {
      const boom = new Error('mongo error')
      mockProjectGetter.promises.getProject.mockRejectedValue(boom)

      await AdminProjectManagementController.renderProjectDetail(req, res, next)

      expect(next).toHaveBeenCalledWith(boom)
      expect(res.render).not.toHaveBeenCalled()
    })
  })

  describe('transferOwnership', () => {
    it.each([
      { name: 'holdingAccount', user: { _id: 'u1', holdingAccount: true, suspended: false } },
      { name: 'suspended', user: { _id: 'u2', holdingAccount: false, suspended: true } },
    ])(
      'rejects transfer to a $name account without calling OwnershipTransferHandler',
      async ({ user }) => {
        req.body.newOwnerEmail = 'target@example.com'
        mockUserGetter.promises.getUserByAnyEmail.mockResolvedValue(user)

        await AdminProjectManagementController.transferOwnership(req, res)

        expect(mockUserGetter.promises.getUserByAnyEmail).toHaveBeenCalledWith(
          'target@example.com',
          { _id: 1, holdingAccount: 1, suspended: 1 }
        )
        expect(
          mockOwnershipTransferHandler.promises.transferOwnership
        ).not.toHaveBeenCalled()
        expect(res.redirect).toHaveBeenCalledWith(
          `/admin/project/${projectId}?error=invalid_target_user`
        )
      }
    )

    it('transfers ownership when target user is active and not a holding account', async () => {
      req.body.newOwnerEmail = 'target@example.com'
      mockUserGetter.promises.getUserByAnyEmail.mockResolvedValue({
        _id: 'u-active',
        holdingAccount: false,
        suspended: false,
      })
      mockOwnershipTransferHandler.promises.transferOwnership.mockResolvedValue()

      await AdminProjectManagementController.transferOwnership(req, res)

      expect(
        mockOwnershipTransferHandler.promises.transferOwnership
      ).toHaveBeenCalledWith(
        projectId,
        'u-active',
        expect.objectContaining({ allowTransferToNonCollaborators: true })
      )
      expect(res.redirect).toHaveBeenCalledWith(
        `/admin/project/${projectId}?success=transferred`
      )
    })
  })
})
