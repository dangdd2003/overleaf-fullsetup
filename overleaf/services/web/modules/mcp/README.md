# Overleaf MCP Server (`mcp`)

Exposes Overleaf projects to MCP-compatible clients through the instance's `/mcp` endpoint. Clients can manage projects and files, search source, compile, inspect logs and PDFs, and access project history. Access is checked against the signed-in user's project permissions.

Clients can authorize with OAuth 2.1 (authorization code with PKCE and refresh tokens) or a personal access token with the `mcp` scope. The MCP REST API also has an OpenAPI description at `/api/v0/mcp/openapi.json`.

## Upstream CE comparison

The upstream Community Edition does not include an Overleaf MCP server. This module adds the MCP endpoint, OAuth authorization, and Overleaf-specific project tools. It is separate from AI Assist's optional connectors to other MCP servers.

## Activation and configuration

Off by default. Set in `variable.env`:

```env
MCP_ENABLED=true
# Optional extra hosts/origins, comma-separated
# MCP_ALLOWED_HOSTS=overleaf.example.org
# MCP_ALLOWED_ORIGINS=https://client.example.org
```

Set the normal `OVERLEAF_SITE_URL` to the public HTTPS URL of this instance. The server derives its OAuth issuer and allowed site host/origin from it. Use the optional host/origin lists only for additional domains; wildcard origins are rejected.

For local stdio transport, configure `MCP_TOKEN` and start the MCP service with `--stdio`. HTTP clients use the site's `/mcp` endpoint and OAuth or a scoped PAT; they do not use `MCP_TOKEN`.

## Data and persistence

OAuth grants and registered clients are stored in MongoDB. The OAuth signing key is kept at `/var/lib/overleaf/oauth2_key.pem`; preserve the Overleaf data volume so clients' existing tokens remain valid after restart. PAT records are in the `personalAccessTokens` collection, shared with Git Bridge.

## Developer design

`services/mcp` accepts tool calls at `/mcp` (or stdio) and forwards them to the web module's `/api/v0/mcp/*` API. `McpRouter` dispatches to project, file, compile, history, and tag handlers; the web module handles OAuth discovery, consent, token exchange, and revocation.

Each protected API call requires the `mcp` scope. OAuth uses authorization code with PKCE; optional `offline_access` allows refresh tokens. Project reads use Overleaf's read permission and mutations require content-write permission. Tags are scoped to the authenticated user. There are no new project roles.

| Mongo collection                | Use                                                                                                       |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| `oauthApplications`             | OAuth client registrations and redirect URIs.                                                             |
| `oauthAuthorizationCodes`       | Short-lived PKCE codes; TTL removes expired records.                                                      |
| `oauthAccessTokens`             | OAuth grants, scopes, audience, and hashed refresh-token state; deleting a grant revokes its access JWTs. |
| `personalAccessTokens` (shared) | Existing user PAT hashes and scopes, also used by Git Bridge.                                             |
| `tags` (shared)                 | Existing per-user project tags.                                                                           |

Project content and compile data stays in the existing Overleaf services and CLSI disk stores; MCP adds no project-content collection. Main boundaries: `McpRouter` and controllers, `McpAuthMiddleware`/`McpAuthorizationMiddleware`, and `OAuth2Router`/`app/src/OAuth2`.
