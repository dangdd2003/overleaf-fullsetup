# Phase 2: Project Administration & Ownership Transfer Design

## 1. Overview & Objective

Phase 2 enhances the Overleaf Admin User Management module with **Project Administration & Ownership Transfer**, providing administrators with the tools to inspect all LaTeX projects owned by any user and seamlessly reassign project ownership (individually or in bulk) when team members, researchers, or students transition out of an organization.

This directly integrates with Overleaf's battle-tested enterprise transfer engine (`OwnershipTransferHandler.mjs`) to preserve collaborator roles, Git/TPDS cache consistency, and audit logging.

---

## 2. Architecture & API Endpoints

All endpoints are registered in `AdminUserManagementRouter.mjs`, secured with `AuthorizationMiddleware.ensureUserIsSiteAdmin`, and rate-limited.

```
+--------------------------------------------------------------------------------------------------+
| Admin User Detail Page (/admin/users/:userId)                                                     |
+--------------------------------------------------------------------------------------------------+
         |                                                 |
         | GET .../projects                                | GET /search-users?query=...
         | POST .../projects/:projectId/transfer           |
         | POST .../projects/transfer-all                  |
         v                                                 v
+------------------------------------+             +-----------------------------------------------+
| Project.mjs & ProjectGetter.mjs    |             | OwnershipTransferHandler.mjs                  |
| - Filter: { owner_ref: userId }    |             | - transferOwnership(projectId, newOwnerId)    |
| - Search by name regex             |             | - transferAllProjectsToUser(fromUser, toUser) |
+------------------------------------+             +-----------------------------------------------+
```

### 2.1. REST Endpoints

#### `GET /admin/users/api/users/:userId/projects`
* **Purpose**: Retrieve a paginated, searchable, and sortable list of projects owned by `userId`.
* **Query Parameters**:
  * `page` (number, default: 1)
  * `limit` (number, default: 10)
  * `search` (string, optional: case-insensitive name substring)
  * `sort` (string, default: `lastUpdated`, options: `lastUpdated`, `name`)
  * `order` (string, default: `desc`, options: `asc`, `desc`)
* **Backend Logic**:
  1. Validate `userId` as a valid ObjectId.
  2. Query `Project.find({ owner_ref: userId, archived: { $ne: true } })`.
  3. Return projection: `{ _id, name, lastUpdated, collaberator_refs, readOnly_refs, publicAccesLevel, rootDoc_id }`.
* **Response Payload (200 OK)**:
  ```json
  {
    "projects": [
      {
        "_id": "6a92abcaf7cb4d17ece59486",
        "name": "Machine Learning Paper",
        "lastUpdated": "2026-08-29T10:00:00.000Z",
        "collaboratorCount": 2,
        "accessLevel": "private"
      }
    ],
    "total": 1,
    "page": 1,
    "totalPages": 1
  }
  ```

#### `GET /admin/users/api/search-users`
* **Purpose**: Fast type-ahead user search to resolve destination user IDs for the transfer modal.
* **Query Parameters**: `query` (string, min length: 1)
* **Backend Logic**:
  1. Query `User.find` matching `email`, `first_name`, or `last_name` with case-insensitive regex.
  2. Limit to top 5 results with safe projection `{ _id, email, first_name, last_name, isAdmin }`.
* **Response Payload (200 OK)**:
  ```json
  {
    "users": [
      {
        "_id": "6a929d69c5fd734cf2a08f76",
        "email": "alex.morgan@university.edu",
        "first_name": "Alex",
        "last_name": "Morgan",
        "isAdmin": false
      }
    ]
  }
  ```

#### `POST /admin/users/api/users/:userId/projects/:projectId/transfer`
* **Purpose**: Transfer ownership of a single LaTeX project to a new owner.
* **Request Payload**:
  ```json
  {
    "newOwnerId": "6a929d69c5fd734cf2a08f76"
  }
  ```
* **Validation & Execution**:
  1. Verify `newOwnerId` is a valid ObjectId and not equal to `userId` (`400 { error: 'cannot_transfer_to_self' }`).
  2. Verify destination user exists in `db.users`.
  3. Call `OwnershipTransferHandler.promises.transferOwnership(projectId, newOwnerId, { fromUserId: userId, ipAddress: req.ip })`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "projectId": "6a92abcaf7cb4d17ece59486",
    "newOwnerId": "6a929d69c5fd734cf2a08f76"
  }
  ```

#### `POST /admin/users/api/users/:userId/projects/transfer-all`
* **Purpose**: Bulk-transfer all projects owned by `userId` to `toUserId`.
* **Request Payload**:
  ```json
  {
    "toUserId": "6a929d69c5fd734cf2a08f76"
  }
  ```
* **Validation & Execution**:
  1. Verify `toUserId` is valid and not equal to `userId`.
  2. Call `OwnershipTransferHandler.promises.transferAllProjectsToUser({ fromUserId: userId, toUserId, ipAddress: req.ip })`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "transferredCount": 4,
    "newTagName": "transferred-from-author@example.com"
  }
  ```

---

## 3. Frontend UI & Component Layout

Placed as a full-width section at the bottom of `/admin/users/:userId`:

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 📁 USER PROJECTS (Total: 4)                                       [ 📦 Transfer All Projects ]   │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ 🔍 Search projects by title... ]                                                                │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ PROJECT NAME                       LAST UPDATED       COLLABORATORS   ACCESS     ACTIONS          │
│ Quantum Computing Research Draft   Aug 29, 2026       3 members       Private    [ Transfer ]     │
│ Machine Learning Survey 2026       Aug 25, 2026       1 member        Private    [ Transfer ]     │
│ Neural Architecture Benchmarks     Jul 10, 2026       5 members       Public     [ Transfer ]     │
│ Physics 101 Lecture Notes          Jun 01, 2026       0 members       Private    [ Transfer ]     │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Showing 1 to 4 of 4 projects                                              < [1] >                 │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Components
1. **`AdminUserProjectsCard`**:
   - Manages state: `projects`, `total`, `page`, `searchQuery`, `isLoading`.
   - Renders responsive table, search filter input, and pagination bar.
   - Triggers `TransferProjectModal` for single project or bulk transfer mode.
2. **`TransferProjectModal`**:
   - Type-ahead search input calling `/admin/users/api/search-users`.
   - Selected recipient preview card (Avatar, Full Name, Email, ID).
   - Explanatory safety notice regarding collaborator permissions and tag creation.
   - Confirm button with loading state.

---

## 4. Invariant Safeguards & Error Handling

| Scenario / Edge Case | Handled By | Outcome / Behavior |
| :--- | :--- | :--- |
| **Transfer to same user** | `POST .../transfer` & `transfer-all` | Blocked: `400 { error: 'cannot_transfer_to_self' }` |
| **Destination user does not exist** | `POST .../transfer` & `transfer-all` | Blocked: `404 { error: 'destination_user_not_found' }` |
| **Project not owned by user** | `POST .../transfer` | Blocked: `403 { error: 'not_project_owner' }` |
| **Original author continuous access** | `OwnershipTransferHandler` | Original owner demoted to read-and-write collaborator |
| **Git / TPDS cache out of sync** | `OwnershipTransferHandler` | `TpdsProjectFlusher` flushes cached repository metadata |

---

## 5. Verification & Test Plan

### 5.1. Unit Tests (`Vitest`)
* `AdminUserProjects.test.mjs`:
  * `getUserProjects`: Pagination, regex search, projection filtering.
  * `searchUsers`: Type-ahead matching email/name, projection safety.
  * `transferProject`: Invokes `OwnershipTransferHandler.promises.transferOwnership`.
  * `transferAllProjects`: Invokes `transferAllProjectsToUser` and verifies counts.

### 5.2. Live Container Integration Test
* Test script verifying:
  1. Creating 2 projects for User A.
  2. Single transfer of Project 1 to User B -> verify `owner_ref` swapped, User A in collaborators.
  3. Bulk transfer of Project 2 to User B -> verify all projects under User B with `transferred-from-...` tag.
