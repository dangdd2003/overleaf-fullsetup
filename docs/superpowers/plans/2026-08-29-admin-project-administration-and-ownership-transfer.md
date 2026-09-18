# Phase 2: Project Administration & Ownership Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement administrative LaTeX project inspection, type-ahead destination user search, single project ownership transfer, and bulk project transfer inside the Overleaf Admin User Management module.

**Architecture:** Extend `AdminUserManagementRouter.mjs` and `AdminUserManagementController.mjs` with 4 rate-limited, site-admin-guarded REST endpoints integrating directly with `Project.mjs` (MongoDB) and Overleaf's native `OwnershipTransferHandler.mjs`. On the frontend, embed a full-width `AdminUserProjectsCard` at the bottom of `/admin/users/:userId` featuring pagination, search filtering, and a type-ahead `TransferProjectModal`.

**Tech Stack:** Node.js (ESM), Express 4, MongoDB (mongodb/Mongoose), React 18, TypeScript, Vitest, Bootstrap 5 / Overleaf Design Tokens (`OLCard`, `OLButton`, `OLBadge`, `OLModal`, `OLTable`).

## Global Constraints

- **Directory Boundary**: All new backend logic and frontend components MUST be placed inside `overleaf/services/web/modules/admin-user-management/`.
- **Native Engine Reuse**: Ownership transfer MUST use `OwnershipTransferHandler.promises.transferOwnership` and `transferAllProjectsToUser` to ensure collaborator permissions, project audit logs, and TPDS/Git cache invalidation are preserved.
- **Self-Transfer Invariant**: Rejects any attempt to transfer a project to the same user (`400 { error: 'cannot_transfer_to_self' }`).
- **Authorization**: Every endpoint MUST require `AuthorizationMiddleware.ensureUserIsSiteAdmin` and mutations MUST be rate-limited.
- **Git Rules**: Never run `git commit` or `git push` directly in automation; provide clean commands for the user.

---

### Task 1: User Projects Query & Type-Ahead User Search Backend Endpoints

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsQuery.test.mjs`

**Interfaces:**
- `AdminUserManagementController.getUserProjects(req, res)`:
  - Query: `page`, `limit`, `search`, `sort`, `order`
  - Output: `200 { projects: [{ _id, name, lastUpdated, collaboratorCount, accessLevel }], total, page, totalPages }`
- `AdminUserManagementController.searchUsers(req, res)`:
  - Query: `query`
  - Output: `200 { users: [{ _id, email, first_name, last_name, isAdmin }] }`

- [ ] **Step 1: Write failing unit test for projects query and user search**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsQuery.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import { Project } from '../../../../../../app/src/models/Project.mjs'
import { User } from '../../../../../../app/src/models/User.mjs'

vi.mock('../../../../../../app/src/models/Project.mjs', () => ({
  Project: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

vi.mock('../../../../../../app/src/models/User.mjs', () => ({
  User: {
    find: vi.fn(),
  },
}))

describe('AdminUserProjectsQuery Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getUserProjects returns paginated projects for user', async () => {
    const mockQuery = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          _id: 'proj1',
          name: 'Quantum Draft',
          lastUpdated: new Date('2026-08-29T10:00:00Z'),
          collaberator_refs: ['user2', 'user3'],
          readOnly_refs: [],
          publicAccesLevel: 'private',
        },
      ]),
    }
    Project.find.mockReturnValue(mockQuery)
    Project.countDocuments.mockResolvedValue(1)

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      query: { page: '1', limit: '10' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.getUserProjects(req, res)

    expect(res.json).toHaveBeenCalledWith({
      projects: [
        expect.objectContaining({
          _id: 'proj1',
          name: 'Quantum Draft',
          collaboratorCount: 2,
        }),
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    })
  })

  it('searchUsers returns top matching users', async () => {
    const mockQuery = {
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          _id: 'user2',
          email: 'alex@example.com',
          first_name: 'Alex',
          last_name: 'Smith',
          isAdmin: false,
        },
      ]),
    }
    User.find.mockReturnValue(mockQuery)

    const req = {
      query: { query: 'alex' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.searchUsers(req, res)

    expect(res.json).toHaveBeenCalledWith({
      users: [
        expect.objectContaining({
          email: 'alex@example.com',
          first_name: 'Alex',
        }),
      ],
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsQuery.test.mjs`
Expected: FAIL with `getUserProjects is not a function`.

- [ ] **Step 3: Implement controller and router methods**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
```javascript
import { Project } from '../../../../app/src/models/Project.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import escapeStringRegexp from 'escape-string-regexp'

// Inside controller:
  async getUserProjects(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
      const search = (req.query.search || '').trim()
      const sort = req.query.sort === 'name' ? 'name' : 'lastUpdated'
      const order = req.query.order === 'asc' ? 1 : -1

      const matchQuery = {
        owner_ref: new ObjectId(userId),
        archived: { $ne: true },
      }
      if (search) {
        matchQuery.name = new RegExp(escapeStringRegexp(search), 'i')
      }

      const [projects, total] = await Promise.all([
        Project.find(matchQuery, {
          name: 1,
          lastUpdated: 1,
          collaberator_refs: 1,
          readOnly_refs: 1,
          publicAccesLevel: 1,
        })
          .sort({ [sort]: order })
          .skip((page - 1) * limit)
          .limit(limit),
        Project.countDocuments(matchQuery),
      ])

      const formattedProjects = (projects || []).map(p => ({
        _id: p._id.toString(),
        name: p.name || 'Untitled Project',
        lastUpdated: p.lastUpdated || null,
        collaboratorCount:
          (p.collaberator_refs?.length || 0) + (p.readOnly_refs?.length || 0),
        accessLevel: p.publicAccesLevel || 'private',
      }))

      return res.json({
        projects: formattedProjects,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error getting user projects')
      return res.status(500).json({ error: 'failed_to_get_projects' })
    }
  },

  async searchUsers(req, res) {
    try {
      const query = (req.query.query || '').trim()
      if (!query || query.length < 1) {
        return res.json({ users: [] })
      }

      const regex = new RegExp(escapeStringRegexp(query), 'i')
      const users = await User.find(
        {
          $or: [{ email: regex }, { first_name: regex }, { last_name: regex }],
          holdingAccount: { $ne: true },
        },
        {
          _id: 1,
          email: 1,
          first_name: 1,
          last_name: 1,
          isAdmin: 1,
        }
      ).limit(5)

      return res.json({ users: users || [] })
    } catch (err) {
      logger.error({ err, query: req.query.query }, 'error searching users')
      return res.status(500).json({ error: 'failed_to_search_users' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
```javascript
    webRouter.get(
      '/admin/users/api/users/:userId/projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserProjects
    )

    webRouter.get(
      '/admin/users/api/search-users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.searchUsers
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsQuery.test.mjs`
Expected: PASS.

---

### Task 2: Project Ownership Transfer Backend Endpoints (Single & Bulk)

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsTransfer.test.mjs`

**Interfaces:**
- `AdminUserManagementController.transferProject(req, res)`:
  - Params: `userId`, `projectId`
  - Body: `{ newOwnerId: string }`
  - Output: `200 { success: true, projectId, newOwnerId }`
- `AdminUserManagementController.transferAllProjects(req, res)`:
  - Params: `userId`
  - Body: `{ toUserId: string }`
  - Output: `200 { success: true, transferredCount: number, newTagName: string }`

- [ ] **Step 1: Write failing unit test for transfer endpoints**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsTransfer.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import OwnershipTransferHandler from '../../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import UserGetter from '../../../../../../app/src/Features/User/UserGetter.mjs'

vi.mock(
  '../../../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs',
  () => ({
    default: {
      promises: {
        transferOwnership: vi.fn(),
        transferAllProjectsToUser: vi.fn(),
      },
    },
  })
)

vi.mock('../../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUser: vi.fn(),
    },
  },
}))

describe('AdminUserProjectsTransfer Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('transferProject rejects self-transfer with 400', async () => {
    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76', projectId: 'proj1' },
      body: { newOwnerId: '6a929d69c5fd734cf2a08f76' },
      ip: '127.0.0.1',
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.transferProject(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'cannot_transfer_to_self' })
  })

  it('transferProject invokes OwnershipTransferHandler and returns success', async () => {
    UserGetter.promises.getUser.mockResolvedValue({ _id: 'newOwner' })
    OwnershipTransferHandler.promises.transferOwnership.mockResolvedValue()

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76', projectId: 'proj1' },
      body: { newOwnerId: '6a929d69c5fd734cf2a08f99' },
      ip: '127.0.0.1',
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.transferProject(req, res)

    expect(OwnershipTransferHandler.promises.transferOwnership).toHaveBeenCalledWith(
      'proj1',
      '6a929d69c5fd734cf2a08f99',
      { fromUserId: '6a929d69c5fd734cf2a08f76', ipAddress: '127.0.0.1' }
    )
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      projectId: 'proj1',
      newOwnerId: '6a929d69c5fd734cf2a08f99',
    })
  })

  it('transferAllProjects invokes transferAllProjectsToUser and returns count and tag', async () => {
    UserGetter.promises.getUser.mockResolvedValue({ _id: 'toUser' })
    OwnershipTransferHandler.promises.transferAllProjectsToUser.mockResolvedValue({
      projectCount: 4,
      newTagName: 'transferred-from-old@test.com',
    })

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      body: { toUserId: '6a929d69c5fd734cf2a08f99' },
      ip: '127.0.0.1',
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.transferAllProjects(req, res)

    expect(
      OwnershipTransferHandler.promises.transferAllProjectsToUser
    ).toHaveBeenCalledWith({
      fromUserId: '6a929d69c5fd734cf2a08f76',
      toUserId: '6a929d69c5fd734cf2a08f99',
      ipAddress: '127.0.0.1',
    })
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      transferredCount: 4,
      newTagName: 'transferred-from-old@test.com',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsTransfer.test.mjs`
Expected: FAIL with `transferProject is not a function`.

- [ ] **Step 3: Implement controller and router methods**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
```javascript
import OwnershipTransferHandler from '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'

// Inside controller:
  async transferProject(req, res) {
    try {
      const { userId, projectId } = req.params
      const { newOwnerId } = req.body || {}

      if (!ObjectId.isValid(userId) || !ObjectId.isValid(newOwnerId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }
      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ error: 'invalid_project_id' })
      }
      if (userId === newOwnerId) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }

      const destinationUser = await UserGetter.promises.getUser(newOwnerId, { _id: 1 })
      if (!destinationUser) {
        return res.status(404).json({ error: 'destination_user_not_found' })
      }

      await OwnershipTransferHandler.promises.transferOwnership(projectId, newOwnerId, {
        fromUserId: userId,
        ipAddress: req.ip,
      })

      return res.json({
        success: true,
        projectId,
        newOwnerId,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId, projectId: req.params.projectId }, 'error transferring project')
      return res.status(500).json({ error: 'failed_to_transfer_project' })
    }
  },

  async transferAllProjects(req, res) {
    try {
      const { userId } = req.params
      const { toUserId } = req.body || {}

      if (!ObjectId.isValid(userId) || !ObjectId.isValid(toUserId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }
      if (userId === toUserId) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }

      const destinationUser = await UserGetter.promises.getUser(toUserId, { _id: 1 })
      if (!destinationUser) {
        return res.status(404).json({ error: 'destination_user_not_found' })
      }

      const result = await OwnershipTransferHandler.promises.transferAllProjectsToUser({
        fromUserId: userId,
        toUserId,
        ipAddress: req.ip,
      })

      return res.json({
        success: true,
        transferredCount: result?.projectCount || 0,
        newTagName: result?.newTagName || '',
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error transferring all projects')
      return res.status(500).json({ error: 'failed_to_transfer_all_projects' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
```javascript
    webRouter.post(
      '/admin/users/api/users/:userId/projects/:projectId/transfer',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.transferProject
    )

    webRouter.post(
      '/admin/users/api/users/:userId/projects/transfer-all',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.transferAllProjects
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserProjectsTransfer.test.mjs`
Expected: PASS.

---

### Task 3: Type-Ahead Transfer Modal Component

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/transfer-project-modal.tsx`

**Interfaces:**
```typescript
export interface TransferProjectModalProps {
  show: boolean
  onHide: () => void
  fromUserId: string
  fromUserEmail: string
  projectId?: string
  projectName?: string
  isBulk?: boolean
  totalProjectCount?: number
  onSuccess: (message: string) => void
}
```

- [ ] **Step 1: Create `transfer-project-modal.tsx`**

Implement `TransferProjectModal` with:
- Text input for typing email/name with debounced `getJSON('/admin/users/api/search-users?query=...')`.
- Selected user preview box with avatar/email.
- Explanatory notice regarding collaborator demotion and tags.
- Post request to `/transfer` (single) or `/transfer-all` (bulk) with `{ body: { newOwnerId } }` or `{ body: { toUserId } }`.
- Error and loading state management.

---

### Task 4: User Projects Table Card Component & Integration

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-projects-card.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-detail-page.tsx`

- [ ] **Step 1: Create `admin-user-projects-card.tsx`**

Implement `AdminUserProjectsCard`:
- Fetches `getJSON('/admin/users/api/users/${userId}/projects?page=...&search=...')`.
- Renders responsive table with Columns: Project Name, Last Updated, Collaborators, Access Level, Actions (`[ Transfer ]` button).
- Header with search filter and "Transfer All Projects" button.
- Pagination controls.

- [ ] **Step 2: Mount `AdminUserProjectsCard` in `admin-user-detail-page.tsx`**

Place full-width `<AdminUserProjectsCard>` at the bottom of the User Detail page.

- [ ] **Step 3: Verify Webpack compilation**

Run: `docker compose logs --tail=10 webpack`
Expected: `webpack 5.106.2 compiled successfully`.

---

### Task 5: Live Container E2E Integration & Verification

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/`
Expected: All unit tests pass across all test files.

- [ ] **Step 2: Run container E2E integration test**

Execute live test in `web` container:
- Create 2 projects under User A.
- Transfer Project 1 to User B -> verify `owner_ref` swapped and collaborator retained.
- Transfer all remaining projects to User B -> verify bulk reassignment and tag creation.
Expected: PASS (0 errors).
