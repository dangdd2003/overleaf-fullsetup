# Google Drive Sync Module (`google-drive-sync`)

Keeps selected Overleaf projects synchronized with a user's Google Drive account. It supports project-level sync, bulk sync of existing projects, and importing Drive folders as Overleaf projects. The module is disabled by default.

## Upstream CE comparison

This Google Drive integration is an extension in this repository; it is not part of the stock upstream Overleaf CE user flow. Official Overleaf documentation describes cloud integrations as plan features and lists the self-hosted CE and Server Pro feature differences separately. See [Server Pro vs. Community Edition](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) and [Free and premium features](https://docs.overleaf.com/getting-started/free-and-premium-plans/premium-features). With the module disabled, the standard CE experience remains unchanged.

## User workflow

1. Create a Google OAuth client and enable the Google Drive API for its Cloud project.
2. Set the callback URI to `<OVERLEAF_SITE_URL>/oauth/google-drive/callback`, then link the account in **Account Settings → Project Synchronization**. Google consent requests Drive access and the user's email identity.
3. Choose projects for bulk sync, or import selected Google Drive folders as Overleaf projects. For one project, open **Integrations → Google Drive** and sync or review its status.
4. After a project is linked, changes sync in both directions. HTTPS instances receive Drive push notifications; HTTP instances use polling. Concurrent edits that conflict are preserved as timestamped conflict copies, which the user can review in the project panel.

The default Drive folder is `Overleaf`. Users can unlink their account from settings; this disconnects linked projects from future synchronization.

## Setup

Add these variables to `variable.env` and restart the `overleaf` service:

| Environment variable                   | Default   | Purpose                                                                                                                                                                          |
| :------------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_DRIVE_ENABLED`                 | `false`   | Enable Google Drive Sync.                                                                                                                                                        |
| `GOOGLE_DRIVE_CLIENT_ID`               | —         | Google OAuth client ID.                                                                                                                                                          |
| `GOOGLE_DRIVE_CLIENT_SECRET`           | —         | Google OAuth client secret.                                                                                                                                                      |
| `GOOGLE_DRIVE_MAX_RPS`                 | `8`       | Maximum Google Drive API requests per second. Adjust to the Google Cloud project quota.                                                                                          |
| `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS`   | `300`     | Polling interval when push notifications are unavailable.                                                                                                                        |
| `GOOGLE_DRIVE_OUTBOUND_FLUSH_SECONDS`  | `600`     | Maximum wait before queued Overleaf changes are sent to Drive.                                                                                                                   |
| `GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET` | Generated | Encryption key for saved Google OAuth tokens. The init script generates and persists it under `/var/lib/overleaf/secret`; set it explicitly only when managing the key yourself. |

The OAuth callback is derived from `OVERLEAF_SITE_URL`. The webhook URL is also derived from it and is registered only for HTTPS site URLs; otherwise Drive changes are found by polling.

## Data and recovery

MongoDB stores account credentials, project-to-folder links, sync state, and import/bulk-sync jobs. OAuth tokens are encrypted. The encryption secret is persisted in `/var/lib/overleaf/secret/GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET`, within the Overleaf data volume. Back up MongoDB and the Overleaf data volume together to preserve links and decrypt saved tokens.

## Developer design

The panel is in `frontend/js/features/google-drive-sync`. `/auth/google-drive/*` routes handle account and job requests, `/project/:Project_id/google-drive/*` handles project actions, and `/google-drive/webhook` receives Drive notifications. `GoogleDriveRouter` and `GoogleDriveController` call `GoogleDriveSyncManager`, which maps Overleaf docs/files to Drive items. Workers run in the web service when enabled.

| Collection                   | Purpose                                                                                                |
| :--------------------------- | :----------------------------------------------------------------------------------------------------- |
| `googleDriveUserCredentials` | One linked account per user; encrypted tokens, Drive change cursor, and push-watch channel details.    |
| `googleDriveProjectStates`   | Project/folder link, file and folder ID maps, pending outbound changes, sync status, lock, and errors. |
| `googleDriveBulkSyncJobs`    | Per-user bulk sync queue and per-project progress.                                                     |
| `googleDriveImportJobs`      | Per-user folder import/scan queue and per-folder progress.                                             |

Project state has unique project and Drive-folder indexes. Each user can have one active job of each kind; finished jobs expire after 30 days. File contents remain in Overleaf and Google Drive; binary downloads are staged briefly in `TMPDIR` (or the OS temp directory) and removed after use. The module adds no local repository directory, Overleaf role, or project ACL.

Account routes require login. Project status checks read access; sync and conflict dismissal check write access. A Drive webhook only validates its watch channel and schedules a poll; the poll reads Drive changes and applies them to linked projects. Overleaf edit hooks record outbound work for the flush worker. Manual sync, bulk sync, and folder import enter the same manager through the authenticated routes, with Mongo job records allowing bulk work to resume after a web restart.
