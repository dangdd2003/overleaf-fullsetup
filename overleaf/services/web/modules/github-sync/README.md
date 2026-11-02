# GitHub Sync Module (`github-sync`)

Connect an Overleaf project to a GitHub repository. Users can import a repository as a project, then manually pull or push changes. The module is disabled by default.

## Upstream CE comparison

Upstream Overleaf CE does not include built-in GitHub repository synchronization. This module adds an opt-in OAuth and project sync flow to CE while leaving the default CE behavior unchanged. The official [Server Pro vs. Community Edition comparison](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) describes the self-hosted CE baseline.

## User workflow

1. Link a GitHub account from **Account Settings → Project Synchronization**. The OAuth app requests `repo` and `user:email` access so it can list and update repositories, including private repositories the user can access.
2. Choose **New Project → GitHub**, select a repository and branch, and import it as a linked Overleaf project.
3. From the project's Integrations panel, choose **Pull** to merge the repository's default branch into Overleaf, or **Push** to publish Overleaf changes with a commit message.
4. If a pull conflicts, resolve the conflict in the repository working tree and continue the merge. Unlinking removes the project association.

Pull and push are manual. Only the user who linked a project can sync it, and they must still have project write access. A pull can create a conflict branch; the panel displays its name and offers **Continue merge** after the conflict is resolved.

## Setup

Create a GitHub OAuth app and set its callback URL to `<OVERLEAF_SITE_URL>/auth/github/callback`. Configure these in `variable.env`:

| Environment variable             | Default                  | Purpose                                                                                                                                                                    |
| :------------------------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_SYNC_ENABLED`            | `false`                  | Enable GitHub Sync.                                                                                                                                                        |
| `GITHUB_CLIENT_ID`               | —                        | OAuth app client ID.                                                                                                                                                       |
| `GITHUB_CLIENT_SECRET`           | —                        | OAuth app client secret.                                                                                                                                                   |
| `GITHUB_API_BASE`                | `https://api.github.com` | GitHub API URL; change for GitHub Enterprise.                                                                                                                              |
| `GITHUB_GIT_BASE`                | `https://github.com`     | Git URL base; change for GitHub Enterprise.                                                                                                                                |
| `GITHUB_TOKEN_ENCRYPTION_SECRET` | Generated                | Encryption key for stored OAuth tokens. The init script generates and persists it under `/var/lib/overleaf/secret`; set it explicitly only when managing the key yourself. |

Restart the `overleaf` service after configuration. The account and project UI appears only when `GITHUB_SYNC_ENABLED=true`.

## Data and recovery

MongoDB stores linked-account credentials and project/repository state. OAuth tokens are encrypted. Local repository working data is under `/var/lib/overleaf/data/github-sync/repos`; the encryption secret is under `/var/lib/overleaf/secret`. Back up MongoDB and the Overleaf data volume together so account links remain usable.

## Developer design

The module UI is in `frontend/js/features/github-sync`; `/auth/github/*` routes handle account linking/import, and `/project/:projectId/github/*` routes handle project actions. `GitHubOAuthRouter` and `GitHubSyncRouter` call `GitHubSyncManager`, which coordinates the Git working tree and project content through `ProjectContentIO` and `SyncFileOps`.

| Collection                  | Purpose                                                                                                          |
| :-------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `githubSyncUserCredentials` | One GitHub account per Overleaf user; stores provider identity and encrypted OAuth token.                        |
| `githubSyncProjectStates`   | One repository link per project; stores linking user, branch, last synced commit, lock, sync status, and errors. |

Indexes enforce one credential per user and one link per project. Project working clones live under `/var/lib/overleaf/data/github-sync/repos/<projectId>`; this module does not add fields to project content to hold repository files. It sets the existing user's `features.github` flag and GitHub third-party identifier during account linking. It adds no Overleaf role or project ACL.

All web routes require a signed-in user. Project status requires read access; create-repository, pull, push, project unlink, and merge continuation require project write access. Only the linking user can sync a linked project, and creating a repository link also checks project ownership. Account OAuth/unlink and repository import use the signed-in user's account; import creates a new project. OAuth callbacks save encrypted credentials, import clones a repository and copies its tree into that project, and pull/push materialize the current project into the per-project clone before merging or publishing. Project edit hooks mark outgoing changes; sync remains user-triggered.
