# Phase 1: Real-Time Active Sessions & Admin Email Management Design

## 1. Overview & Objective

Phase 1 enhances the Overleaf Admin User Management module with **Real-Time Active Sessions Management** and **Administrative Email Management**, matching the official Overleaf Server Pro & Enterprise feature specifications without external SSO dependencies.

This gives site administrators immediate administrative control to:
1. Inspect live connected browser sessions and client IP addresses stored in Redis.
2. Force-logout (revoke all sessions) for any user or their own account (with self-retention safeguard).
3. Add verified secondary email addresses, remove secondary emails, and promote secondary emails to primary.

---

## 2. Architecture & API Endpoints

All endpoints are registered in `AdminUserManagementRouter.mjs`, mounted under `/admin/users/api/users/:userId/`, guarded by `AuthorizationMiddleware.ensureUserIsSiteAdmin`, and rate-limited.

```
+--------------------------------------------------------------------------------------------------+
| Web Browser (Admin Panel)                                                                        |
+--------------------------------------------------------------------------------------------------+
         |                                                 |
         | GET /sessions                                   | POST /emails/add
         | POST /sessions/revoke                           | POST /emails/remove
         |                                                 | POST /emails/set-primary
         v                                                 v
+------------------------------------+             +-----------------------------------------------+
| UserSessionsManager.mjs (Redis)    |             | UserUpdater.mjs & UserGetter.mjs (MongoDB)    |
| - Key: UserSessions:{userId}       |             | - db.users.find / updateOne                   |
| - Key: sess:{sessionId}            |             | - emails: [{ email, confirmedAt }]            |
+------------------------------------+             +-----------------------------------------------+
```

### 2.1. Active Sessions Endpoints (Redis)

#### `GET /admin/users/api/users/:userId/sessions`
* **Purpose**: Query active connected browser sessions from Redis.
* **Backend Logic**:
  1. Call `UserSessionsManager.getAllUserSessions({ _id: userId })`.
  2. Parse session records from `UserSessions:{userId}` set and `sess:{sessionId}` keys.
* **Response Payload (200 OK)**:
  ```json
  {
    "sessions": [
      {
        "ip_address": "192.168.1.50",
        "session_created": "2026-08-29T09:30:00.000Z"
      }
    ],
    "count": 1
  }
  ```

#### `POST /admin/users/api/users/:userId/sessions/revoke`
* **Purpose**: Force-logout account across all devices by purging session keys in Redis.
* **Backend Logic**:
  1. Verify `userId` is valid.
  2. Check if caller is revoking their own account:
     ```js
     const callerUserId = SessionManager.getLoggedInUserId(req.session)
     const retainSessionID = callerUserId === userId ? req.sessionID : null
     ```
  3. Call `UserSessionsManager.removeSessionsFromRedis({ _id: userId }, retainSessionID)`.
  4. Log event in `UserAuditLogHandler.record(userId, 'admin-revoked-sessions', { callerUserId, retainedSelf: Boolean(retainSessionID) })`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "revokedCount": 2
  }
  ```

---

### 2.2. Admin Email Management Endpoints (MongoDB)

#### `POST /admin/users/api/users/:userId/emails/add`
* **Purpose**: Add a secondary email directly to the user's account.
* **Request Payload**:
  ```json
  {
    "email": "user.secondary@university.edu"
  }
  ```
* **Validation & Conflict Checks**:
  1. Parse & normalize email via `EmailHelper.parseEmail(req.body.email)`. If invalid, return `400 { error: 'invalid_email' }`.
  2. Query `UserGetter.promises.getUserByAnyEmail(email)` across `db.users` and `db.deletedUsers`. If found, return `409 { error: 'email_already_registered' }`.
* **Persistence**:
  1. Call `UserUpdater.promises.addEmailAddress(userId, email, { confirmed: true })`.
  2. Log audit event `admin-added-email`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "user": { ...updatedUserProjection }
  }
  ```

#### `POST /admin/users/api/users/:userId/emails/remove`
* **Purpose**: Remove a secondary email address from the user's account.
* **Request Payload**:
  ```json
  {
    "email": "user.secondary@university.edu"
  }
  ```
* **Validation**:
  1. Fetch user. If `email === user.email` (attempting to remove primary email), return `400 { error: 'cannot_remove_primary_email' }`.
* **Persistence**:
  1. Call `UserUpdater.promises.removeEmailAddress(userId, email)`.
  2. Log audit event `admin-removed-email`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "user": { ...updatedUserProjection }
  }
  ```

#### `POST /admin/users/api/users/:userId/emails/set-primary`
* **Purpose**: Promote an existing secondary email to become the account's primary email.
* **Request Payload**:
  ```json
  {
    "email": "user.secondary@university.edu"
  }
  ```
* **Persistence**:
  1. Call `UserUpdater.promises.setDefaultEmailAddress(userId, email)`.
  2. Log audit event `admin-set-primary-email`.
* **Response Payload (200 OK)**:
  ```json
  {
    "success": true,
    "user": { ...updatedUserProjection }
  }
  ```

---

## 3. Frontend UI & Component Design

The User Detail Page (`/admin/users/:userId`) maintains a balanced 2-column responsive layout:

```
+---------------------------------------------------------------------------------------------------+
|  < Back to Users     User: John Doe [Site Admin]                                                  |
|                      john.doe@example.com                                                         |
+---------------------------------------------------------------------------------------------------+
|                                                 |                                                 |
|  LEFT COLUMN (Width: 7/12)                      |  RIGHT COLUMN (Width: 5/12)                     |
|                                                 |                                                 |
|  ┌───────────────────────────────────────────┐  |  ┌───────────────────────────────────────────┐  |
|  │ 📇 PROFILE INFORMATION & EMAILS           │  |  │ 🔑 PASSWORD MANAGEMENT                    │  |
|  │                                           │  |  │ [ Generate Password Reset Link ]          │  |
|  │ First Name: [ John      ]                 │  |  │ https://overleaf.local/set-password/...   │  |
|  │ Last Name:  [ Doe       ]                 │  |  └───────────────────────────────────────────┘  |
|  │                                           │  |                                                 |
|  │ ── Email Addresses ────────────────────── │  |  ┌───────────────────────────────────────────┐  |
|  │ • john.doe@example.com   [ Primary ]      │  |  │ 🛡️ SECURITY & ACTIVE SESSIONS             │  |
|  │ • jdoe@lab.org  [Make Primary] [Delete]   │  |  │ Active Sessions: 2                        │  |
|  │                                           │  |  │ • 192.168.1.50 (Logged in 2 hrs ago)      │  |
|  │ + Add Secondary Email:                    │  |  │ • 10.0.0.12    (Logged in 1 day ago)      │  |
|  │ [ new.email@domain.com ] [ Add Email ]    │  |  │                                           │  |
|  │                                           │  |  │ [ ⚠️ Revoke All Sessions (Force Logout) ] │  |
|  │ [ Save Profile Changes ]                  │  |  └───────────────────────────────────────────┘  |
|  └───────────────────────────────────────────┘  |                                                 |
|                                                 |  ┌───────────────────────────────────────────┐  |
|  ┌───────────────────────────────────────────┐  |  │ ℹ️ ACCOUNT METADATA                       │  |
|  │ 👑 SITE ADMINISTRATOR ACCESS              │  |  │ User ID: 6a929d...                        │  |
|  │ [x] Grant Site Administrator Privileges   │  |  │ Signed Up: Aug 28, 2026                   │  |
|  │ [ Save Permissions ]                      │  |  │ Last Active: 10 mins ago                  │  |
|  └───────────────────────────────────────────┘  |  └───────────────────────────────────────────┘  |
|                                                 |                                                 |
|                                                 |  ┌───────────────────────────────────────────┐  |
|                                                 |  │ ⚠️ DANGER ZONE                            │  |
|                                                 |  │ [ Delete User Account ]                   │  |
|                                                 |  └───────────────────────────────────────────┘  |
+---------------------------------------------------------------------------------------------------+
```

### 3.1. Components
1. **`AdminUserProfileEmailsCard`**:
   - Contains First/Last Name inputs and interactive email management table.
   - Shows badge indicators (`Primary`, `Confirmed`, `Unconfirmed`).
   - "Make Primary" button and "Remove" button with loading spinners.
   - Inline "Add Secondary Email" form with client-side regex check.
2. **`AdminUserSessionsCard`**:
   - Fetches active sessions from `/admin/users/api/users/:userId/sessions` on load.
   - Displays session counter badge and formatted IP list.
   - "Revoke All Sessions" trigger button (`variant="outline-danger"`).
3. **`RevokeSessionsModal`**:
   - Confirmation dialog explaining that the user will be logged out on all devices.
   - Dispatches `/sessions/revoke` and updates parent state.

---

## 4. Invariant Safeguards & Error Handling

| Scenario / Edge Case | Handled By | Outcome / Behavior |
| :--- | :--- | :--- |
| **Attempting to delete primary email** | `POST .../emails/remove` | Blocked: `400 { error: 'cannot_remove_primary_email' }` |
| **Adding duplicate/existing email** | `POST .../emails/add` | Blocked: `409 { error: 'email_already_registered' }` |
| **Admin revoking own sessions** | `POST .../sessions/revoke` | `retainSessionID: req.sessionID` passed; caller stays logged in |
| **Empty or invalid email syntax** | `POST .../emails/add` | Normalization & regex check returns `400 { error: 'invalid_email' }` |
| **Target user does not exist** | All endpoints | `404 { error: 'user_not_found' }` |

---

## 5. Verification & Test Plan

### 5.1. Unit Tests (`Vitest`)
* `AdminUserEmails.test.mjs`:
  * Adding valid secondary email -> persists in `emails` array.
  * Adding duplicate email -> rejects with 409.
  * Removing secondary email -> removes from array.
  * Attempting to remove primary email -> rejects with 400.
  * Setting primary email -> swaps primary and updates `user.email`.
* `AdminUserSessions.test.mjs`:
  * Fetching sessions from Redis -> formats IP addresses and dates.
  * Revoking all sessions -> calls `UserSessionsManager.removeSessionsFromRedis`.
  * Revoking self sessions -> verifies `retainSessionID` is supplied.

### 5.2. Live Container Integration Test
* Script executing against live Redis and MongoDB in container:
  1. Add secondary email to test account -> verify MongoDB `emails` array.
  2. Promote secondary email to primary -> verify `user.email` changed.
  3. Remove original secondary email -> verify array pruned.
  4. Inject mock Redis session keys -> verify `/sessions` returns count.
  5. Call `/sessions/revoke` -> verify Redis keys purged.
