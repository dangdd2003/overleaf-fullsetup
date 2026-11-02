# Personal Access Token Module (`personal-access-token`)

Creates and manages scoped `olp_...` tokens for tools that authenticate without a browser session. Tokens can be created from the account's Git token settings and from the Git Bridge clone dialog; the secret is displayed only at creation.

## Upstream CE comparison

Upstream CE does not include Git Bridge, which Overleaf lists as a Server Pro feature in its [roles and permissions guide](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions), or this scoped token manager. This module provides personal tokens for this repository's Git Bridge and MCP extensions.

## Activation and use

There is no separate toggle. Token management is enabled when either `GIT_BRIDGE_ENABLED=true` or `MCP_ENABLED=true`.

Supported scopes are `git_bridge` and `mcp`. Choose only the scope the client needs. Tokens expire one year after creation; each user can have up to 20 active tokens and can revoke them from account settings. Git Bridge clients need `git_bridge`; MCP clients need `mcp`.

The authenticated endpoints are `GET` and `POST /user/personal-access-tokens`, and `DELETE /user/personal-access-tokens/:tokenId`. Creation and revocation require the logged-in session and CSRF protection. A generated token is shown once; MongoDB stores its SHA-256 hash, not the token secret. Records live in the `personalAccessTokens` collection and are removed when the owning account is deleted.

## Developer design

The module adds the session-protected router and controller under `modules/personal-access-token`; the shared `Features/PersonalAccessToken/PersonalAccessTokenManager` creates and validates credentials for Git Bridge and MCP. The `PersonalAccessToken` model adds one collection, `personalAccessTokens`: each record belongs to a `User` and stores the token hash, display prefix, scopes, timestamps, and expiry. A unique hash index supports authentication; a `user_id` index supports listing and account cleanup. Raw token values are returned only during creation.

Tokens are user credentials, not project roles or ACL entries; this module adds no Overleaf roles. Consumers hash the presented token to find its user and scopes, then apply their own checks: Git Bridge requires `git_bridge` plus normal project read/write permission. Token routes exist only when Git Bridge or MCP is enabled; creating a token also enforces the per-user active-token limit and rate limit.
