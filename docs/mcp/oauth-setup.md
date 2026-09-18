# Overleaf MCP OAuth 2.1 Setup & Connection Guide

Overleaf MCP supports standard **OAuth 2.1** with **RFC 7636 (PKCE)** and **RFC 9728 (OAuth 2.0 Protected Resource Metadata)**. This enables secure, browser-based, zero-manual-token authentication for AI assistants, IDEs, and agentic workflows.

---

## Architecture & Protocols

```
┌─────────────────┐                                  ┌───────────────────────────┐
│   AI Assistant  │                                  │        Overleaf           │
│  (Claude, GPT,  │                                  │  (Authorization Server    │
│   Gemini, etc.) │                                  │      & Resource Server)   │
└────────┬────────┘                                  └─────────────┬─────────────┘
         │                                                         │
         │ 1. GET /mcp (unauthenticated)                           │
         ├────────────────────────────────────────────────────────►│ (:3050 /mcp)
         │ 2. 401 Unauthorized + WWW-Authenticate: Bearer ...     │
         │    resource_metadata="/.well-known/oauth-protected..." │
         │◄────────────────────────────────────────────────────────┤
         │                                                         │
         │ 3. GET /.well-known/oauth-protected-resource (RFC 9728) │
         ├────────────────────────────────────────────────────────►│
         │ 4. { authorization_servers: ["http://...:3000"] }       │
         │◄────────────────────────────────────────────────────────┤
         │                                                         │
         │ 5. GET /.well-known/oauth-authorization-server (RFC 8414│
         ├────────────────────────────────────────────────────────►│ (:3000 web)
         │ 6. { authorization_endpoint, token_endpoint, jwks_uri } │
         │◄────────────────────────────────────────────────────────┤
         │                                                         │
         │ 7. Browser Consent: GET /oauth/authorize (PKCE S256)    │
         ├────────────────────────────────────────────────────────►│
         │ 8. User Approves -> Redirect with ?code=...             │
         │◄────────────────────────────────────────────────────────┤
         │                                                         │
         │ 9. POST /oauth/token (code + code_verifier)             │
         ├────────────────────────────────────────────────────────►│
         │ 10. Mint RS256 JWT access token + refresh token         │
         │◄────────────────────────────────────────────────────────┤
         │                                                         │
         │ 11. MCP Request: POST /mcp (Authorization: Bearer JWT)  │
         ├────────────────────────────────────────────────────────►│ (:3050 mcp)
         │ 12. Stateless JWT Verification via cached JWKS          │
         │ 13. Returns MCP Tool Result / Stream                    │
         │◄────────────────────────────────────────────────────────┤
```

### Standard Endpoints

| Protocol Standard | Endpoint Path | Description |
|---|---|---|
| **RFC 9728** | `/.well-known/oauth-protected-resource` | Protected resource metadata identifying auth servers and scopes |
| **RFC 8414** | `/.well-known/oauth-authorization-server` | Auth server metadata, endpoints, PKCE methods, supported grants |
| **RFC 7517** | `/.well-known/jwks.json` | Public RS256 signing keys for stateless token verification |
| **RFC 6749 / 2.1** | `/oauth/authorize` | Interactive consent and authorization grant endpoint |
| **RFC 6749 / 2.1** | `/oauth/token` | Token issuance and refresh endpoint (PKCE S256 required) |
| **RFC 7591** | `/oauth/register` | Dynamic Client Registration for automated MCP client onboarding |

---

## 1. Claude Desktop & Claude Code

Claude natively discovers OAuth 2.1 authorization servers via RFC 9728 and launches the system browser for one-click authorization.

### Claude Desktop

Edit your Claude Desktop configuration file:
* **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "overleaf": {
      "url": "http://localhost:3050/mcp"
    }
  }
}
```

*When connecting over a remote network or domain, use your domain URL (e.g., `https://overleaf.example.com/mcp`).*

**Connection Flow:**
1. Restart Claude Desktop.
2. Claude attempts to connect to `http://localhost:3050/mcp`.
3. Overleaf returns a 401 challenge with `WWW-Authenticate` pointing to OAuth metadata.
4. Claude automatically launches your default web browser to the Overleaf consent page (`/oauth/authorize`).
5. Click **Authorize**.
6. Claude captures the authorization code via loopback callback, acquires an RS256 JWT access token, and establishes the MCP connection.

### Claude Code CLI

Add the Overleaf MCP server using the CLI:

```bash
claude mcp add overleaf http://localhost:3050/mcp
```

Or configure via `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "type": "http",
      "url": "http://localhost:3050/mcp"
    }
  }
}
```

---

## 2. ChatGPT (OpenAI Connectors & Actions)

OpenAI supports OAuth 2.1 authentication across ChatGPT Custom Actions, Codex CLI, and Developer Platform Connectors.

### Option A: ChatGPT Desktop / Codex CLI

In `~/.codex/config.json` or ChatGPT Desktop MCP settings:

```json
{
  "mcpServers": {
    "overleaf": {
      "url": "http://localhost:3050/mcp"
    }
  }
}
```

### Option B: Custom GPT Action with OAuth 2.1

When creating a Custom GPT on `chatgpt.com`:

1. In the GPT Builder, click **Configure** -> **Create new action**.
2. **Schema:** Import URL `http://<your-overleaf-host>/api/v0/mcp/openapi.json`.
3. **Authentication Type:** Select **OAuth**.
4. **Configuration Settings:**
   * **Client ID:** `chatgpt-action` (or client ID from `/oauth/register`)
   * **Client Secret:** *(leave empty for public PKCE clients)*
   * **Authorization URL:** `http://<your-overleaf-host>/oauth/authorize`
   * **Token URL:** `http://<your-overleaf-host>/oauth/token`
   * **Scope:** `mcp`
   * **Token Exchange Method:** `Default (POST request with body)`
5. Save the Action. Users chatting with the GPT will see a **Sign in with Overleaf** button.

---

## 3. Google Gemini (Goose & LibreChat)

Gemini models (e.g. Gemini 3.8 Flash, Gemini 2.5 Pro) connect via open-source MCP host environments.

### Option A: Block Goose CLI

Goose is an open-source autonomous agent harness by Block supporting OAuth-enabled MCP servers.

Configure in `~/.config/goose/config.yaml`:

```yaml
extensions:
  overleaf:
    type: sse
    uri: http://localhost:3050/mcp
```

When Goose starts, it detects the 401 challenge and opens your browser to complete authorization.

### Option B: LibreChat

LibreChat supports multi-model chats with OAuth 2.1 MCP tool integrations.

Add to `librechat.yaml`:

```yaml
mcpServers:
  overleaf:
    type: streamable-http
    url: http://localhost:3050/mcp
```

LibreChat authenticates via PKCE and manages refresh tokens across user sessions automatically.

---

## 4. Manual / Scripted OAuth 2.1 Handshake (RFC 7636)

For custom integrations or testing, execute the standard PKCE handshake:

### Step 1: Generate PKCE Code Verifier & Challenge

In Node.js:
```javascript
import crypto from 'node:crypto';

const codeVerifier = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto
  .createHash('sha256')
  .update(codeVerifier)
  .digest('base64url');

console.log({ codeVerifier, codeChallenge });
```

### Step 2: Request Authorization

Direct the user's browser to:
```
http://localhost:3000/oauth/authorize?client_id=my-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&scope=mcp&code_challenge=CODE_CHALLENGE&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A3050%2Fmcp
```

### Step 3: Exchange Code for Access Token

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "AUTH_CODE_RECEIVED",
    "code_verifier": "CODE_VERIFIER",
    "client_id": "my-app",
    "redirect_uri": "http://localhost:8080/callback"
  }'
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "oar_0123456789abcdef...",
  "scope": "mcp"
}
```

### Step 4: Refresh Expired Access Tokens

```bash
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "refresh_token",
    "refresh_token": "oar_0123456789abcdef...",
    "client_id": "my-app"
  }'
```

---

## Security Features

1. **PKCE S256 Enforced:** Plain code verifiers are rejected; only SHA-256 challenges are accepted.
2. **Stateless RS256 JWT Verification:** The MCP microservice verifies tokens locally using JWKS without blocking database or web service calls.
3. **Single-Use Authorization Codes:** Codes are deleted immediately upon exchange to prevent replay attacks.
4. **Token Rotation:** Refresh tokens are rotated on each use with strict expiration policies.
5. **Audience & Scope Validation:** JWT tokens must contain `aud: "<mcp-resource-uri>"` and `scope: "mcp"`.
