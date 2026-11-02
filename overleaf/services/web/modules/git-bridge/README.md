# Git Bridge Module (`git-bridge`)

Adds Git-over-HTTPS access to Overleaf projects. Users clone, pull, and push with standard Git clients; project permissions determine whether a token can read or write each project. The module is disabled by default and requires the separate `git-bridge` service.

## Upstream CE comparison

Upstream Overleaf CE does not include Git Bridge. The official documentation lists this integration for Server Pro. This module and its companion service make scoped Git access available in this CE extension. See the [official CE/Server Pro comparison](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) and [Git integration documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration).

## Setup

Enable the web module in `variable.env` and configure the service address to match the Compose service name and port:

```env
GIT_BRIDGE_ENABLED=true
GIT_BRIDGE_HOST=git-bridge
GIT_BRIDGE_PORT=8000
```

The `git-bridge` container must be running and able to reach the Overleaf API. Its runtime settings, data directory, file limits, and optional S3 repo offload are documented in [`services/git-bridge/README.md`](../../../git-bridge/README.md). Personal Access Tokens are available when Git Bridge or the MCP server is enabled; users create a token with the `git_bridge` scope from account settings.

## Use

Use the project's Git URL with a Personal Access Token as the HTTPS password. A token only grants the scopes selected at creation, and project-level Overleaf permissions still apply. The bridge stores repository data and transfers project snapshots through the Overleaf API; it does not turn projects into directly browseable host folders.

## Access scope

Git Bridge supports project clone/fetch and push operations. Read operations require project read access; pushes require project write access. Tokens can be revoked from account settings. Password-based Git authentication is an optional service setting; Personal Access Tokens are the recommended credential.

## Developer design

This module exposes `/api/v0/docs/:projectId/*` and `/oauth/token/info` from `web/modules/git-bridge`; the separate `services/git-bridge` process speaks Git over HTTPS and keeps the bare repositories. The service's configured `rootGitDirectory` holds repo and attachment data, with optional repo offload through its swap store. The web API reads existing project, docstore, file-store, history, and `projectHistoryLabels` data; push payloads are staged briefly under the web process's OS temp directory and cleaned after processing. Git Bridge creates no MongoDB collections, Overleaf roles, or project ACLs of its own.

Request flow: the Git service validates credentials through `/oauth/token/info`, reads project snapshots and saved versions from the web API, then fetches binary files from short-lived project/file-scoped URLs. For pushes it posts the changed snapshot and base version; the web API rejects stale versions, accepts valid work with `202`, applies the update asynchronously, and posts the result back to the bridge.

Personal Access Tokens must include `git_bridge`; this scope authenticates the client but does not grant project membership. Snapshot reads require Overleaf project read access and pushes require project content write access. Signed file URLs are limited to one project file or blob and expire after one hour. Session and OAuth callers also pass through the same project permission checks.
