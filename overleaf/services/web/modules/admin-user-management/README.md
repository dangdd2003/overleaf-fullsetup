# Admin User Management Module (`admin-user-management`)

Adds a site-admin workspace for user accounts at `/admin/users`. It is disabled by default.

## What admins can do

- Search and inspect active or deleted users by name, email, or ID.
- Create accounts in bulk; edit profile and email details; change site-admin status; and generate password-reset links.
- Review account audit logs, inspect owned projects, and revoke sessions individually or in batches.
- Soft-delete, restore, or permanently purge accounts. Transfer one user's projects or all of them to another owner.

The module also provides signed-in users with secondary-email add, verification, resend, and removal actions where those routes are not supplied by another feature.

## Activation

Enable site-admin privileges and the module in `variable.env`:

```env
ADMIN_PRIVILEGE_AVAILABLE=true
ADMIN_USER_MANAGEMENT_ENABLED=true
```

Only users with site-admin privileges can open the admin pages or call the admin APIs. User mutations are rate-limited. The module prevents an admin from deleting themself or removing the final active site admin.

## Developer design

- **App flow:** A feature-gated router exposes server-rendered admin pages and JSON APIs. The admin UI calls those APIs; controllers delegate account, project-transfer, audit, email, and session work to existing Overleaf services. Signed-in users' secondary-email routes use a separate login guard.
- **MongoDB:** The module creates no collections. It reads and updates `users` (account details, email addresses, and `isAdmin`), `projects` (project ownership), `deletedUsers` and `deletedProjects` (recoverable deletion archives), `userAuditLogEntries` (account audit history), and `tokens` (core one-time password-reset tokens).
- **Session and recovery data:** Session revocation uses the existing session store through `UserSessionsManager`; it does not add a sessions collection. Deleted accounts remain archived until restored or purged.
- **Roles and guards:** Uses the existing site-admin flag; it adds no role. Admin pages and APIs require `ADMIN_PRIVILEGE_AVAILABLE=true`, `isAdmin: true`, and the module flag. Secondary-email self-service requires login and acts on the signed-in user's own account. Guards prevent self-deletion and removal of the final active site admin.

## Upstream CE comparison

Upstream Overleaf CE has limited user administration. This module adds the searchable directory, account governance, bulk actions, audit views, and project transfers described above. Overleaf's [Server Pro vs. Community Edition comparison](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) describes the distinction between CE and the expanded Server Pro admin panel. This module is a CE extension and does not require Server Pro.
