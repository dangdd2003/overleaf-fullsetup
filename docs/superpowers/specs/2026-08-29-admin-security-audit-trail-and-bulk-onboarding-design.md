# Phase 3: Security Audit Trail & Single/Bulk User Onboarding Design

## 1. Overview & Objective

Phase 3 enhances the Overleaf Admin User Management module with:
1. **User Security Audit Trail**: A chronological activity and security event timeline for each account on `/admin/users/:userId`, tracking administrative actions (role changes, password resets, session revocations, project ownership transfers, and soft deletions/restorations).
2. **Single & Direct Bulk User Creation / CSV Importer**: An in-place modal on `/admin/users` supporting:
   - **Single User Creation**: Fast form with optional password (if provided, user can log in immediately; if blank, generates 7-day single-use activation link).
   - **Direct Table Multi-Row & CSV Import**: Multi-row editable table or drag-and-drop `.csv` file upload (`email,first_name,last_name,password,isAdmin`) with automated password hashing, activation link generation, and CSV result export.

---

## 2. Architecture & API Endpoints

All endpoints are registered in `AdminUserManagementRouter.mjs`, secured with `AuthorizationMiddleware.ensureUserIsSiteAdmin`, and rate-limited.

```
+--------------------------------------------------------------------------------------------------+
| Admin Panel Web UI                                                                               |
+--------------------------------------------------------------------------------------------------+
         |                                                 |
         | GET /users/:userId/audit-logs                   | POST /users/create
         |                                                 | POST /users/bulk-create
         v                                                 v
+------------------------------------+             +-----------------------------------------------+
| UserAuditLogEntry.mjs (MongoDB)    |             | UserCreator & AuthenticationManager (MongoDB) |
| - Filter: { userId }               |             | - Hash passwords via bcrypt                   |
| - Sort: { createdAt: -1 }          |             | - Generate 7-day OneTimeTokens                |
+------------------------------------+             +-----------------------------------------------+
```

### 2.1. REST Endpoints

#### `GET /admin/users/api/users/:userId/audit-logs`
* **Purpose**: Fetch paginated security audit trail entries for a specific user.
* **Query Parameters**: `page` (number, default: 1), `limit` (number, default: 10).
* **Backend Logic**:
  1. Validate `userId` as ObjectId.
  2. Query `UserAuditLogEntry.find({ userId: new ObjectId(userId) }).sort({ createdAt: -1 })`.
  3. Format operation types into human-readable descriptions.
* **Response Payload (200 OK)**:
  ```json
  {
    "auditLogs": [
      {
        "_id": "6a92abc...",
        "operation": "admin-set-admin-status",
        "initiatorId": "6a929d69c5fd734cf2a08f76",
        "ipAddress": "192.168.1.50",
        "info": { "isAdmin": true },
        "createdAt": "2026-08-29T10:15:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "totalPages": 1
  }
  ```

#### `POST /admin/users/api/users/bulk-create`
* **Purpose**: Batch create users from direct on-screen table rows or parsed CSV data.
* **Request Payload**:
  ```json
  {
    "users": [
      {
        "email": "student1@univ.edu",
        "first_name": "Alice",
        "last_name": "Smith",
        "password": "PreAssignedPassword123!",
        "isAdmin": false
      },
      {
        "email": "professor@univ.edu",
        "first_name": "Robert",
        "last_name": "Langdon",
        "password": "",
        "isAdmin": true
      }
    ]
  }
  ```
* **Processing Rules per User**:
  1. Parse & normalize email via `EmailHelper.parseEmail`. If invalid, append to `failed` (`reason: 'invalid_email'`).
  2. Check if email exists in `db.users` or `db.deletedUsers`. If exists, append to `skipped` (`reason: 'email_already_exists'`).
  3. Create user document via `UserCreator.promises.createNewUser({ email, first_name, last_name, isAdmin, holdingAccount: false })`.
  4. If `password` string is provided:
     - Hash password via `AuthenticationManager.hashPassword(password)`.
     - Set `hashedPassword` on user document.
     - Append to `created` with `passwordSet: true, setupUrl: null`.
  5. If `password` is empty/omitted:
     - Generate single-use token via `OneTimeTokenHandler.promises.getNewToken('password', user._id)`.
     - Append to `created` with `passwordSet: false, setupUrl: "${siteUrl}/user/password/set?token=${token}"`.
  6. Log audit event `admin-register` or `admin-bulk-register`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "summary": { "total": 2, "createdCount": 2, "skippedCount": 0, "failedCount": 0 },
    "created": [
      {
        "email": "student1@univ.edu",
        "first_name": "Alice",
        "last_name": "Smith",
        "passwordSet": true,
        "setupUrl": null
      },
      {
        "email": "professor@univ.edu",
        "first_name": "Robert",
        "last_name": "Langdon",
        "passwordSet": false,
        "setupUrl": "http://localhost:81/user/password/set?token=abc..."
      }
    ],
    "skipped": [],
    "failed": []
  }
  ```

---

## 3. Frontend UI & Component Design

### 3.1. `CreateUsersModal` (on `/admin/users`)
* **Tab 1: Single User (`[ 👤 Single User ]`)**:
  - `Email Address *` (required input)
  - `First Name` & `Last Name` (side-by-side)
  - `Password (Optional)` (if provided, account is active immediately; if left blank, generates setup link)
  - `[ ] Grant Site Administrator Access` (checkbox)
  - `[ 🚀 Create User ]` button
* **Tab 2: Bulk & CSV Import (`[ 👥 Bulk & CSV Import ]`)**:
  - Interactive multi-row table with `[ + Add another user row ]`.
  - CSV file drop zone / paste textarea that parses `.csv` (`email,first_name,last_name,password,isAdmin`) and auto-populates the table rows.
  - `[ 🚀 Import Users ]` submit button.
* **Post-Creation Summary Screen**:
  - Success breakdown metrics.
  - Copyable setup link pill buttons for accounts generated with activation tokens.
  - `[ 📥 Export Results as CSV ]` button.

### 3.2. `AdminUserAuditTrailCard` (on `/admin/users/:userId`)
* Chronological timeline card displaying user security history.
* Event badges: `[Admin Access]`, `[Sessions]`, `[Email]`, `[Password]`, `[Account]`, `[Projects]`.
* Formatted timestamp, initiator IP address, and details.
* `[ Load More ]` pagination button.

---

## 4. Invariant Safeguards & Error Handling

| Scenario / Edge Case | Handled By | Outcome / Behavior |
| :--- | :--- | :--- |
| **Duplicate email in bulk batch** | `POST .../bulk-create` | Skipped row appended to `skipped: [...]`; valid rows still created |
| **Invalid email syntax in batch** | `POST .../bulk-create` | Skipped row appended to `failed: [...]`; valid rows still created |
| **Password hashing security** | `AuthenticationManager` | Hashed with bcrypt and salt; never stored or logged in plaintext |
| **Setup token security** | `OneTimeTokenHandler` | Single-use 7-day cryptographically secure token |
| **Audit log tenant isolation** | `GET .../audit-logs` | Strictly filtered by `userId` |

---

## 5. Verification & Test Plan

### 5.1. Unit Tests (`Vitest`)
* `AdminUserBulkCreate.test.mjs`:
  * Single user creation with password -> verifies `hashedPassword` set in Mongo.
  * Single user creation without password -> verifies 7-day `OneTimeToken` generated.
  * Bulk user creation with mixed valid, duplicate, and invalid rows -> verifies summary counts.
* `AdminUserAuditTrail.test.mjs`:
  * Paginated queries against `UserAuditLogEntry`.
  * Event description formatting and error handling.

### 5.2. Live Container Integration Test
* Execute batch creation of 3 accounts in container:
  1. Account with explicit password -> verify password hash and authentication.
  2. Account with setup link -> verify token valid in database.
  3. Duplicate account -> verify non-blocking skip.
  4. Query audit trail for account -> verify chronological timeline.
