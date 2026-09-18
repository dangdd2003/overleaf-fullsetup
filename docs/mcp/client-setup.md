# Connecting Chatbots & AI Assistants to Overleaf MCP

The Overleaf MCP microservice provides authoring, inspection, and compilation tools over the Model Context Protocol. This guide covers how to connect the 3 major AI assistants (**Claude**, **ChatGPT**, and **Gemini**) to the server.

---

## Authentication Methods

Overleaf MCP supports two authentication methods:

1. **OAuth 2.1 (Recommended)**: Seamless browser-based authorization using PKCE (RFC 7636) and Protected Resource Metadata (RFC 9728). No manual token creation or secret sharing required.
2. **Personal Access Tokens (PAT)**: Static bearer tokens generated in Account Settings with the `mcp` scope (format: `olp_...`). Ideal for automated CI/CD scripts and head-less environments.

For a deep dive into OAuth 2.1 flow diagrams and RFC specifications, see [OAuth 2.1 Setup Guide](oauth-setup.md).

---

## Prerequisites

* **Server Endpoint**: Default local dev is `http://localhost:3050/mcp` (or your remote host: `https://<server-domain>/mcp`).
* **DNS Rebinding Protection**: If using remote access, ensure the client host or domain is included in `MCP_ALLOWED_HOSTS` (e.g. `MCP_ALLOWED_HOSTS=overleaf.example.com,localhost,127.0.0.1`).
* **Personal Access Token (if not using OAuth 2.1)**:
  - Log into Overleaf $\to$ **Account Settings** $\to$ **Personal Access Tokens**.
  - Create a token with the **`mcp`** scope (format: `olp_...`).

---

## 1. Claude (Claude Desktop & Claude Code)

Anthropic provides first-party native support for MCP and RFC 9728 OAuth discovery.

### Method A: OAuth 2.1 (Recommended)

#### Claude Desktop (`claude_desktop_config.json`)
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

*When Claude Desktop connects, it automatically detects the 401 challenge and opens your browser for one-click authorization.*

#### Claude Code CLI

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

### Method B: Personal Access Token (Static Token)

If you prefer using a static personal access token:

```json
{
  "mcpServers": {
    "overleaf": {
      "url": "http://localhost:3050/mcp",
      "headers": {
        "Authorization": "Bearer olp_your_token_here"
      }
    }
  }
}
```

### Model Optimization for Claude
* **Recommended Model:** **Claude Opus 5** (or **Claude Sonnet 5** for high-velocity coding).
* **Behavior:**
  * Claude automatically receives the server's `instructions` on connection.
  * Claude excels at surgical string replacement via `edit_file` and line-range slicing via `get_doc_outline` $\to$ `read_file(startLine, endLine)`.
  * Claude natively previews PDFs fetched via `get_compile_pdf` using embedded MCP resource blocks.

---

## 2. ChatGPT (GPT-6 Astra / GPT-5.6)

OpenAI supports tool calling and MCP via ChatGPT Desktop, Codex CLI, and GPT Custom Actions.

### Method A: OAuth 2.1 (Recommended)

#### ChatGPT Desktop / Codex CLI (`~/.codex/config.json`)

```json
{
  "mcpServers": {
    "overleaf": {
      "url": "http://localhost:3050/mcp"
    }
  }
}
```

#### Custom GPT Action (chatgpt.com)
1. In the GPT Builder, click **Configure** $\to$ **Create new action**.
2. **Schema:** Import URL `http://<your-host>/api/v0/mcp/openapi.json`.
3. **Authentication Type:** Select **OAuth**.
   * **Authorization URL:** `http://<your-host>/oauth/authorize`
   * **Token URL:** `http://<your-host>/oauth/token`
   * **Scope:** `mcp`

### Method B: Personal Access Token

In `~/.codex/config.json` or Custom Action Bearer auth:

```json
{
  "mcpServers": {
    "overleaf": {
      "url": "http://localhost:3050/mcp",
      "headers": {
        "Authorization": "Bearer olp_your_token_here"
      }
    }
  }
}
```

### Model Optimization for ChatGPT
* **Recommended Model:** **GPT-6 Astra** (reasoning effort: `medium` or `high`) or **GPT-5.6 Sol**.
* **Prompting Recommendation:**
  OpenAI models benefit from an explicit directive in Custom Instructions:
  > *"When editing LaTeX files, always use `edit_file` with exact verbatim strings and surrounding context. Avoid rewriting files with `write_file` unless creating new documents."*

---

## 3. Google Gemini (Gemini 3.8 Flash / 2.5 Pro)

To use Gemini models with Overleaf MCP, connect through an MCP-compatible agent harness such as **Goose** or **LibreChat**.

### Method A: OAuth 2.1 (Recommended)

#### Option 1: Block Goose CLI (`~/.config/goose/config.yaml`)

```yaml
extensions:
  overleaf:
    type: sse
    uri: http://localhost:3050/mcp
```
*Goose prompts for browser authorization on first startup.*

#### Option 2: LibreChat (`librechat.yaml`)

```yaml
mcpServers:
  overleaf:
    type: streamable-http
    url: http://localhost:3050/mcp
```

### Method B: Personal Access Token

#### Block Goose CLI (`~/.config/goose/config.yaml`)
```yaml
extensions:
  overleaf:
    type: sse
    uri: http://localhost:3050/mcp
    headers:
      Authorization: Bearer olp_your_token_here
```

#### LibreChat (`librechat.yaml`)
```yaml
mcpServers:
  overleaf:
    type: streamable-http
    url: http://localhost:3050/mcp
    headers:
      Authorization: Bearer olp_your_token_here
```

### Tool Confirmation Prompts

Gemini confirms every action by default, on the assumption that any tool call
may mutate data. It skips the prompt only for tools the server annotates with
`readOnlyHint: true`, so the Overleaf server states all four MCP hints
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
explicitly on all 20 tools rather than relying on protocol defaults, which
resolve pessimistically.

| Tools | Gemini behaviour |
|---|---|
| `list_projects`, `get_project`, `export_project_zip`, `list_files`, `search_files`, `read_file`, `download_file`, `get_doc_outline`, `scan_latex`, `search_bib`, `get_word_count`, `get_compile_log`, `get_compile_pdf`, `compile_project` | Run without a confirmation click. `compile_project` is included because it never changes project content — it only writes Overleaf's own build output. |
| `write_file`, `edit_file`, `move_file`, `upload_asset`, `create_project`, `update_project` | Confirmed on every call. These change the user's documents, and Gemini Spark offers no "always allow" for them. |

If you are on **Gemini Enterprise**, actions are imported as a snapshot of the
tool definitions: after upgrading the server, reload your custom actions, or
Gemini keeps confirming against the annotations it imported earlier.

### Model Optimization for Gemini
* **Recommended Model:** **Gemini 3.8 Flash** (fast autonomous agent execution) or **Gemini 2.5 Pro** (deep context).
* **Prompting Recommendation:**
  Gemini has a tendency to read entire files into its context window. Add this guideline to your agent prompt:
  > *"Always run `get_doc_outline` on LaTeX documents first, and supply `startLine` and `endLine` to `read_file` to inspect only the required section."*

---

## Pre-Packaged MCP Prompts

All connecting assistants can invoke the pre-built prompt workflows registered on the server:

| Prompt | Arguments | Workflow Executed |
|---|---|---|
| `review_project` | `projectId` | Discovers files $\to$ gets outline $\to$ scans citations & broken refs $\to$ checks word count $\to$ test-compiles. |
| `fix_compile_errors` | `projectId`, `buildId?` | Fetches compile log $\to$ diagnoses error lines $\to$ targeted read $\to$ surgical `edit_file` $\to$ recompile with `clearCache`. |
| `edit_section` | `projectId`, `path`, `title` | Gets outline $\to$ extracts startLine/endLine $\to$ fetches section $\to$ applies surgical edits $\to$ verifies compile. |
