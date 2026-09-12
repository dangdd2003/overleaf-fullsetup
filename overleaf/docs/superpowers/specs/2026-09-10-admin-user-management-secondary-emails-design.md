# Design Specification: Self-Service Secondary Emails for Overleaf Community Edition

**Date**: 2026-09-10  
**Status**: Approved / Ready for Implementation Planning  
**Target**: Overleaf Community Edition (Server CE)  
**Parent Module**: `admin-user-management` (`overleaf/services/web/modules/admin-user-management/`)

---

## 1. Overview & Goals

In upstream Overleaf Community Edition (CE), secondary email self-service management (`/user/settings`) is disabled or broken:
- Upstream `router.mjs` gates `/user/emails/delete` and `/user/emails/default` behind the proprietary `affiliations` feature.
- Upstream `POST /user/emails/secondary` is omitted entirely from CE routing.
- The default settings UI (`emails-section.tsx`) expects complex institutional affiliations, university dropdowns, country selectors, and SSO flows that do not apply to self-hosted Community Edition setups.

This specification designs a native, self-contained **Self-Service Secondary Email Management** subsystem as an extension of the `admin-user-management` module. When `admin-user-management` is enabled, any authenticated user can add, manage, make primary, or delete secondary emails directly in `/user/settings` through a clean, affiliation-free interface.

### Primary Goals
1. **Simplified Settings UI**: Remove the "Institution and role" column and all university/affiliation/SSO input fields from `/user/settings`. Display a clean table containing only email addresses, primary badges, and row actions.
2. **One-Click Secondary Email Addition**: Provide a single-field "Add another email" form requiring only an email address.
3. **Immediate Auto-Confirmation**: In CE environments (where outbound SMTP is frequently unconfigured), automatically mark newly added secondary emails as confirmed (`confirmedAt: new Date()`) without requiring a 6-digit confirmation code prompt.
4. **Full Email Lifecycle for Normal Users**: Support promoting confirmed secondary emails to primary and deleting secondary emails (safeguarded against deleting the primary address).
5. **Clean Module Integration**: House all backend endpoints within `admin-user-management` without polluting core upstream CE routing. Gated by `Features.hasFeature('admin-user-management')`.
6. **Playwright UI Verification**: Verify the complete user flow and visual appearance in a real browser using Playwright.

---

## 2. Navigation & User Interface Flow

### 2.1 `/user/settings` Emails Section
The "Emails and affiliations" section is simplified into a clean "Emails" section:

```
+-------------------------------------------------------------------------------+
| Emails                                                                        |
| Add additional email addresses to your account to make sure you can recover   |
| your account and collaborators can find you.                                  |
|                                                                               |
| Email                                                                 Actions |
| ----------------------------------------------------------------------------- |
| user@example.com [Primary]                                                [🗑] |
| ----------------------------------------------------------------------------- |
| secondary@example.com                            [Make primary]           [🗑] |
| ----------------------------------------------------------------------------- |
| + Add another email                                                           |
+-------------------------------------------------------------------------------+
```

### 2.2 Inline "Add another email" Form
Clicking `+ Add another email` expands an inline form:
```
+-------------------------------------------------------------------------------+
| Email: [ name@example.com                         ]   [ Add email ]  [ Cancel ]|
+-------------------------------------------------------------------------------+
```
* Submitting the form calls `POST /user/emails/secondary`.
* On success, the newly added email is immediately auto-confirmed, the table updates via `getEmails()`, and a success notification is shown.

---

## 3. Backend Architecture & Endpoints

All endpoints are registered in `AdminUserManagementRouter.mjs` and guarded by `AuthenticationController.requireLogin()` and mutation rate-limiting.

```
+-------------------------------------------------------------------------------+
| Client Browser (/user/settings)                                              |
+-------------------------------------------------------------------------------+
         |                              |                             |
         | POST /user/emails/secondary  | POST /user/emails/default   | POST /user/emails/delete
         v                              v                             v
+-------------------------------------------------------------------------------+
| AdminUserManagementController (or AdminUserSelfServiceEmailsController)       |
+-------------------------------------------------------------------------------+
         |                              |                             |
         v                              v                             v
+-------------------------------------------------------------------------------+
| UserUpdater / UserGetter / UserAuditLogHandler (MongoDB)                      |
| - Validate RFC email syntax via EmailHelper.parseEmail                        |
| - Verify uniqueness via UserGetter.getUserByAnyEmail                          |
| - Enforce Settings.emailAddressLimit (default 10)                             |
| - Auto-confirm: { confirmedAt: new Date() }                                   |
| - Audit logs: 'add-email', 'set-default-email', 'remove-email'                |
+-------------------------------------------------------------------------------+
```

### 3.1 `POST /user/emails/secondary`
* **Purpose**: Allows the logged-in user to add a secondary email address to their own account.
* **Payload**: `{ "email": "secondary@example.com" }`
* **Processing**:
  1. Extract `userId = SessionManager.getLoggedInUserId(req.session)`.
  2. Parse & validate `email = EmailHelper.parseEmail(req.body.email)`. If invalid, return `400 { error: 'invalid_email' }`.
  3. Check user's current email count against `Settings.emailAddressLimit`. If exceeded, return `422 { error: 'email_limit_exceeded' }`.
  4. Query `UserGetter.getUserByAnyEmail(email)`. If email already exists (active or deleted), return `409 { error: 'email_already_registered' }`.
  5. Call `UserUpdater.addEmailAddress(userId, email, { confirmed: true }, auditLog)`.
  6. Call `UserUpdater.confirmEmail(userId, email)` to ensure `confirmedAt` is explicitly populated.
  7. Log audit event `add-email-auto-confirmed`.
* **Response (200 OK)**:
  ```json
  {
    "success": true,
    "email": "secondary@example.com"
  }
  ```

### 3.2 `POST /user/emails/default`
* **Purpose**: Promotes a confirmed secondary email to primary for the logged-in user.
* **Payload**: `{ "email": "secondary@example.com" }`
* **Processing**:
  1. Extract `userId = SessionManager.getLoggedInUserId(req.session)`.
  2. Parse & validate `email = EmailHelper.parseEmail(req.body.email)`.
  3. Fetch user and verify `email` exists in `user.emails` and has `confirmedAt`.
  4. Call `UserUpdater.setDefaultEmailAddress(userId, email, auditLog)`.
  5. Log audit event `set-default-email`.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

### 3.3 `POST /user/emails/delete`
* **Purpose**: Deletes a secondary email address belonging to the logged-in user.
* **Payload**: `{ "email": "secondary@example.com" }`
* **Processing**:
  1. Extract `userId = SessionManager.getLoggedInUserId(req.session)`.
  2. Parse & validate `email = EmailHelper.parseEmail(req.body.email)`.
  3. Fetch user. If `email === user.email` (primary email), reject with `400 { error: 'cannot_delete_primary_email' }`.
  4. Verify `email` exists in `user.emails`.
  5. Call `UserUpdater.removeEmailAddress(userId, email, auditLog)`.
  6. Log audit event `remove-email`.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

---

## 4. Frontend Component Design

### 4.1 Component Adjustments in `overleaf/services/web/frontend/js/features/settings/`
1. **`emails-section.tsx`**:
   * Inspect feature flag `adminUserManagementEnabled` (passed via meta tag `ol-adminUserManagementEnabled`).
   * When enabled:
     * Set table title to "Emails".
     * Render `SimpleEmailsHeader` (Email column + Actions column).
     * Render `SimpleEmailsRow` (Email, Primary badge, Make Primary action, Delete action).
     * Render `SimpleAddEmailForm` instead of `AddEmail`.
2. **`SimpleEmailsHeader.tsx`**:
   * Two columns: `OLCol lg={8}` for "Email", `OLCol lg={4}` for "Actions" (right-aligned).
   * Omit `institution_and_role`.
3. **`SimpleEmailsRow.tsx`**:
   * Displays email address.
   * If primary: renders `[Primary]` badge; trash icon is disabled.
   * If secondary: renders "Make primary" button and trash icon to delete.
4. **`SimpleAddEmailForm.tsx`**:
   * Compact form with `Input`, `Add` button, and `Cancel` button.
   * Submits to `/user/emails/secondary`.
   * On success: triggers `getEmails()`, closes form, shows success banner.

---

## 5. Security & Invariants

1. **Authentication Guard**: All self-service endpoints require valid session via `AuthenticationController.requireLogin()`.
2. **Ownership Guard**: Users can only modify their own emails (`SessionManager.getLoggedInUserId(req.session)` is strictly enforced).
3. **Primary Email Invariant**: The primary email cannot be removed. Users must promote another email to primary before deleting an old primary.
4. **Collision & Injection Safety**: Email inputs are strictly parsed using `EmailHelper.parseEmail` and checked against collisions in both active and deleted accounts.
5. **Rate Limiting**: Protected by `RateLimiterMiddleware` against brute-force additions.

---

## 6. Testing & Verification Plan

### 6.1 Backend Unit Tests
Location: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs`
* Test adding valid secondary email (returns 200, sets `confirmedAt`).
* Test adding duplicate email (returns 409).
* Test adding invalid email format (returns 400).
* Test exceeding `Settings.emailAddressLimit` (returns 422).
* Test making secondary email primary (returns 200, updates default email).
* Test deleting secondary email (returns 200).
* Test deleting primary email (returns 400).

### 6.2 Browser E2E / Playwright Verification
* Launch Playwright against the development server.
* Log in as `dangdoan2206@gmail.com`.
* Navigate to `/user/settings`.
* Verify the table displays only "Email" and "Actions" headers without "Institution and role".
* Click "+ Add another email", input `test.secondary@example.com`, click "Add".
* Verify the new email appears in the list as confirmed.
* Click "Make primary", verify the `[Primary]` badge moves to the new email.
* Delete the secondary email, verify it disappears from the table.
* Capture Playwright screenshots for visual confirmation.